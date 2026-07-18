// Harness 工程实施计划 阶段5 — Curator（纯函数 + 决策动作）。
//
// `curateCandidates(candidates, existing)`：从 Reflector 输出 + 当前 project_memories 活跃条目
// 产出 6 种 CuratorAction 决策。
//
// 决策规则（按优先级）：
// 1. 标题完全相同 → skip（去重）
// 2. 标题相似（Levenshtein 距离 < 0.2 * maxLen） + 同一 kind → supersede
// 3. 内容矛盾（detectConflict） → mark_disputed 老条目 + create 新条目
// 4. 高 confidence (≥0.95) + kind='context' → create 自动入（无需 confirm）
// 5. 中 confidence (0.7-0.95) → create + **requiresConfirm**
// 6. 决策/偏好/lesson（kind !== 'context'）→ 永远 requiresConfirm=true
// 7. 低 confidence (<0.7) → requiresConfirm=true（更慎重）
//
// 关键不变量：
// - 纯函数（不调 DB；写是 caller 责任）
// - 同 candidate 多次输入产生同 decisions（snapshot 测试）
// - harmful_count > 3 标记的老条目不参与相似度比较（避免死循环）

import type { CuratorDecision, PlaybookCandidate, PlaybookItem } from "./types";

/** Levenshtein 距离（O(n*m)；candidate.title 一般 < 200 字符，可接受） */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost));
    }
    for (let k = 0; k < cur.length; k++) prev[k] = cur[k]!;
  }
  return prev[b.length]!;
}

/** 归一化相似度 0-1（1 = 完全相同） */
function titleSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length, 1);
  return 1 - levenshtein(a, b) / maxLen;
}

/** 检测两个 content 是否矛盾（heuristic：包含互斥关键词对） */
function detectConflict(aContent: string, bContent: string): boolean {
  // 简单启发式：两者都包含"应该" / "不应该"但 conclusion 相反
  // 实际生产用 LLM 软标准（阶段 8 之后做）；第一版只覆盖简单模式
  const aLow = aContent.toLowerCase();
  const bLow = bContent.toLowerCase();
  const conflictingPairs: Array<[string, string]> = [
    ["应该", "不应该"],
    ["use ", "avoid "],
    ["prefer ", "don't use "],
  ];
  for (const [pos, neg] of conflictingPairs) {
    if ((aLow.includes(pos) && bLow.includes(neg)) || (aLow.includes(neg) && bLow.includes(pos))) {
      return true;
    }
  }
  return false;
}

const HIGH_CONFIDENCE_THRESHOLD = 0.95;

const HARMFUL_LOOP_THRESHOLD = 3;

export function curateCandidates(
  candidates: PlaybookCandidate[],
  existing: PlaybookItem[],
): CuratorDecision[] {
  const decisions: CuratorDecision[] = [];
  // exact-title 查重索引：按 kind + normalized title。
  // 必须同时收 active + candidate——requiresConfirm 的 create 落 status='candidate'，
  // 若 candidate 不进索引，同一事件每轮重新 reflect 都会再落一条新 candidate 行，
  // project_memories 无限膨胀（2026-07-17 复检抓到的 HIGH，同 price-catalog 膨胀事故类）。
  // harmful_count 高的条目不参与查重/相似度比较（避免死循环：被踩条目挡住新条目 → 新条目
  // 永远进不来 → 用户反复踩同一条）。
  const byKey = new Map<string, PlaybookItem>();
  for (const item of existing) {
    if (item.status !== "active" && item.status !== "candidate") continue;
    if (item.harmfulCount > HARMFUL_LOOP_THRESHOLD) continue;
    byKey.set(`${item.kind}::${item.title.trim().toLowerCase()}`, item);
  }

  for (const cand of candidates) {
    const key = `${cand.kind}::${cand.title.trim().toLowerCase()}`;
    const exactMatch = byKey.get(key);

    // 1. 完全相同 → skip
    if (exactMatch) {
      decisions.push({
        action: "skip",
        reason: `标题完全相同，跳过重复（existing id=${exactMatch.id}）`,
        requiresConfirm: false,
      });
      continue;
    }

    // 2. 相似度 ≥ 0.8 + 同一 kind → supersede。
    //    排除 sourceKind='manual'：用户手写的记忆绝不被自动提炼的条目免确认 supersede
    //    （manual 条目掉到规则 4-7 走 create+confirm，宁可近重复也不静默覆盖用户资产）；
    //    排除 harmful_count 高的条目（同 byKey 的死循环理由）。
    const similar = existing.find(
      (it) => it.kind === cand.kind
        && it.status === "active"
        && it.sourceKind !== "manual"
        && it.harmfulCount <= HARMFUL_LOOP_THRESHOLD
        && titleSimilarity(it.title.trim().toLowerCase(), cand.title.trim().toLowerCase()) >= 0.8,
    );
    if (similar) {
      decisions.push({
        action: "supersede",
        targetId: similar.id,
        newItem: candToItem(cand),
        reason: `标题相似度 ≥ 0.8（${similar.title} → ${cand.title}），合并并 supersede 老条目`,
        requiresConfirm: false,
      });
      continue;
    }

    // 3. 内容矛盾 → mark_disputed 老条目 + create 新条目（harmful 条目同样不参与）
    const contradicted = existing.find(
      (it) => it.kind === cand.kind
        && it.status === "active"
        && it.harmfulCount <= HARMFUL_LOOP_THRESHOLD
        && detectConflict(it.content, cand.content),
    );
    if (contradicted) {
      decisions.push({
        action: "mark_disputed",
        targetId: contradicted.id,
        reason: `检测到内容矛盾（existing id=${contradicted.id}），标 disputed 后让用户确认`,
        requiresConfirm: true,
      });
      decisions.push({
        action: "create",
        // 2026-07-17 复检 HIGH 修复：supersedesId 携带"这条新 candidate 是跟谁矛盾"的关联，
        // 让 PlaybookPanel 能把 disputed 老条目和新 candidate 配对展示、联动裁决——
        // 否则两边各自独立确认，可能被用户分别点成"都保留"，两条互相矛盾的事实同时 active。
        // 注意：这里只是携带关联引用，不代表真的 supersede（老条目状态由 mark_disputed 决定，
        // 不受这个字段影响；execute 时也不能走 markSuperseded，见 pipeline.ts create 分支）。
        newItem: { ...candToItem(cand), supersedesId: contradicted.id },
        reason: `新增 candidate，与 disputed 老条目（id=${contradicted.id}）配对，等用户联动裁决`,
        requiresConfirm: true,
      });
      continue;
    }

    // 4-7. 决定是否 confirm
    const requiresConfirm =
      cand.confidence < HIGH_CONFIDENCE_THRESHOLD || cand.kind !== "context";

    decisions.push({
      action: "create",
      newItem: candToItem(cand),
      reason: requiresConfirm
        ? `confidence=${cand.confidence} < ${HIGH_CONFIDENCE_THRESHOLD} 或 kind=${cand.kind} 非 context → 需要 confirm`
        : `高 confidence + kind=context 自动入`,
      requiresConfirm,
    });
  }

  return decisions;
}

function candToItem(cand: PlaybookCandidate): Omit<PlaybookItem, "id" | "createdAt" | "updatedAt" | "helpfulCount" | "harmfulCount" | "lastUsedAt"> {
  return {
    projectId: "",  // curator 写库时由 caller 填
    kind: cand.kind,
    title: cand.title,
    content: cand.content,
    importance: cand.importance,
    tags: cand.tags,
    sourceKind: cand.sourceKind,
    sourceRef: cand.sourceRef,
    confidence: cand.confidence,
    status: "active",
    supersedesId: null,
    evidenceRefsJson: JSON.stringify(cand.sourceEventIds),
  };
}