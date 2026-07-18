// Harness 工程实施计划 阶段5 — Playbook 接线管道（2026-07-17 断点①②接线）。
//
// 两个入口，都是旁路语义（失败 console.error，绝不阻塞主对话流）：
// - `recordPlaybookEventSafe`：Generator 端事件写入（stream-finalization / checkpoint 保存 /
//   摘要压缩落库处调用）
// - `runPlaybookPipeline`：消费端。stream-finalization 后台 fire-and-forget 调：
//   listByConversation → reflectPlaybookEvents → curateCandidates → applyCuratorDecisions
//
// 落库纪律（2026-07-17 确认 UI 上线后的完整版）：
// - create + requiresConfirm=false → status='active' 直接入
// - create + requiresConfirm=true → status='candidate' 落候选区（active 过滤天然不入 prompt，
//   由 PlaybookPanel 确认 UI 转正 markActive / 拒绝 markArchived）
// - supersede → create 新条目 + markSuperseded 老条目（curator 判定 requiresConfirm=false 才给；
//   sourceKind='manual' 手建条目在 curator 层豁免）
// - mark_disputed → markDisputed 老条目（退出 prompt 进入待裁决区）+ 伴生 create 的新
//   candidate 携带 supersedesId 指回老条目 id（关联引用，非真 supersede）——PlaybookPanel
//   靠这个字段把两者配对展示、互斥裁决：任一方点"保留/转正"，另一方自动 markArchived，
//   绝不允许两条矛盾事实同时 active（2026-07-17 复检 HIGH：原来两边各自独立确认毫无关联，
//   用户可能都点保留）
// - mark_archived → markArchived（来自 harmful 反馈路径，降权不删，row + supersede 链保留）
// - 重复消费防护：Curator 的 exact-title skip 幂等挡重，查重索引含 active+candidate
//   （candidate 不可见会导致每轮重复落新行无限膨胀——2026-07-17 复检 HIGH，勿回退）

import { playbookEvents } from "@/lib/db";
import { projectMemories, type ProjectMemory } from "@/lib/db/memory";
import { curateCandidates } from "./curator";
import { reflectPlaybookEvents } from "./reflector";
import type { CuratorDecision, PlaybookEventKind, PlaybookItem } from "./types";

/** 旁路写事件：任何失败只 console.error（playbook 是观测面，不许反噬主流程） */
export async function recordPlaybookEventSafe(input: {
  projectId: string;
  conversationId: string | null;
  messageId: string | null;
  kind: PlaybookEventKind;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    await playbookEvents.record({
      projectId: input.projectId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      kind: input.kind,
      payloadJson: JSON.stringify(input.payload),
      occurredAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[playbook] recordPlaybookEventSafe 失败：", err instanceof Error ? err.message : String(err));
  }
}

/** ProjectMemory（DB 层，playbook 字段 optional）→ PlaybookItem（curator 契约，字段 required） */
export function projectMemoryToPlaybookItem(m: ProjectMemory): PlaybookItem {
  return {
    id: m.id,
    projectId: m.projectId,
    kind: (["decision", "lesson", "context", "preference"].includes(m.kind)
      ? m.kind
      : "other") as PlaybookItem["kind"],
    title: m.title,
    content: m.content,
    importance: m.importance,
    tags: (m.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    sourceKind: m.sourceKind ?? "legacy",
    sourceRef: m.sourceRef ?? null,
    confidence: m.confidence ?? 0.5,
    status: m.status ?? "active",
    helpfulCount: m.helpfulCount ?? 0,
    harmfulCount: m.harmfulCount ?? 0,
    lastUsedAt: m.lastUsedAt ?? null,
    supersedesId: m.supersedesId ?? null,
    evidenceRefsJson: m.evidenceRefsJson ?? null,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

export interface ApplyDecisionsStats {
  created: number;
  candidates: number;
  superseded: number;
  disputed: number;
  archived: number;
  skipped: number;
}

/** 按落库纪律执行 CuratorDecision（导出便于单测） */
export async function applyCuratorDecisions(
  projectId: string,
  decisions: CuratorDecision[],
): Promise<ApplyDecisionsStats> {
  const stats: ApplyDecisionsStats = {
    created: 0, candidates: 0, superseded: 0, disputed: 0, archived: 0, skipped: 0,
  };
  for (const d of decisions) {
    if (d.action === "create" && d.newItem) {
      const status = d.requiresConfirm ? "candidate" : "active";
      await projectMemories.create({
        projectId,
        kind: d.newItem.kind,
        title: d.newItem.title,
        content: d.newItem.content,
        importance: d.newItem.importance,
        tags: d.newItem.tags.join(","),
        sourceKind: d.newItem.sourceKind,
        sourceRef: d.newItem.sourceRef,
        confidence: d.newItem.confidence,
        status,
        // disputed 配对 candidate 会带 supersedesId（关联引用，非真 supersede，见 curator.ts
        // mark_disputed 分支注释）；此处必须转发，否则 PlaybookPanel 无法联动裁决（2026-07-17 HIGH）。
        supersedesId: d.newItem.supersedesId,
        evidenceRefsJson: d.newItem.evidenceRefsJson,
      });
      if (status === "candidate") stats.candidates += 1;
      else stats.created += 1;
    } else if (d.action === "supersede" && d.targetId && d.newItem) {
      const created = await projectMemories.create({
        projectId,
        kind: d.newItem.kind,
        title: d.newItem.title,
        content: d.newItem.content,
        importance: d.newItem.importance,
        tags: d.newItem.tags.join(","),
        sourceKind: d.newItem.sourceKind,
        sourceRef: d.newItem.sourceRef,
        confidence: d.newItem.confidence,
        status: "active",
        supersedesId: d.targetId,
        evidenceRefsJson: d.newItem.evidenceRefsJson,
      });
      await projectMemories.markSuperseded(d.targetId, created.id);
      stats.superseded += 1;
    } else if (d.action === "mark_disputed" && d.targetId) {
      // 冲突老条目退出 prompt，进入 PlaybookPanel 待裁决区（保留 markActive / 归档 markArchived）
      await projectMemories.markDisputed(d.targetId);
      stats.disputed += 1;
    } else if (d.action === "mark_archived" && d.targetId) {
      await projectMemories.markArchived(d.targetId);
      stats.archived += 1;
    } else {
      // skip / update_helpful / update_harmful（后两者走 feedback.ts 路径，不在 curate 输出里执行）
      stats.skipped += 1;
    }
  }
  return stats;
}

/**
 * 消费管道：事件 → 候选经验 → 决策 → 落库。
 * - 传 conversationId：消费本次对话事件（stream-finalization 路径）
 * - 不传：消费 project 级最近事件（checkpoint 保存等无对话上下文的路径）
 * fire-and-forget 调用；任何失败旁路吞掉。
 */
export async function runPlaybookPipeline(args: {
  projectId: string;
  conversationId?: string;
}): Promise<ApplyDecisionsStats | null> {
  try {
    const events = args.conversationId
      ? await playbookEvents.listByConversation(args.conversationId, 50)
      : await playbookEvents.listByProject(args.projectId, 50);
    if (events.length === 0) return null;
    const candidates = reflectPlaybookEvents(events);
    if (candidates.length === 0) return null;
    // 查重必须用全量（含 candidate 行）而非 listActiveByProject：requiresConfirm 的 create
    // 落 status='candidate'，若 candidate 对去重索引不可见，同一事件每轮重新消费都会再落
    // 一条新行 → project_memories 无限膨胀（2026-07-17 复检 HIGH）。superseded/archived
    // 行由 curator 自己的 status 过滤排除。
    const existing = await projectMemories.listByProject(args.projectId);
    const decisions = curateCandidates(candidates, existing.map(projectMemoryToPlaybookItem));
    return await applyCuratorDecisions(args.projectId, decisions);
  } catch (err) {
    console.error("[playbook] runPlaybookPipeline 失败：", err instanceof Error ? err.message : String(err));
    return null;
  }
}
