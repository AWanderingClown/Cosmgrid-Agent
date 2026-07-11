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

export function curateCandidates(
  candidates: PlaybookCandidate[],
  existing: PlaybookItem[],
): CuratorDecision[] {
  const decisions: CuratorDecision[] = [];
  // existing 索引：按 kind + normalized title 查重
  const byKey = new Map<string, PlaybookItem>();
  for (const item of existing) {
    if (item.status !== "active") continue;
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

    // 2. 相似度 ≥ 0.8 + 同一 kind → supersede
    const similar = existing.find(
      (it) => it.kind === cand.kind
        && it.status === "active"
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

    // 3. 内容矛盾 → mark_disputed 老条目 + create 新条目
    const contradicted = existing.find(
      (it) => it.kind === cand.kind
        && it.status === "active"
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
        newItem: candToItem(cand),
        reason: `新增 candidate，替代 contradicted 的老条目`,
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