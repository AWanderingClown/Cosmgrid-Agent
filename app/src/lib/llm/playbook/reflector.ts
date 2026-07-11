// Harness 工程实施计划 阶段5 — Reflector（纯函数）。
//
// `reflectPlaybookEvents(events, ctx)`：从 PlaybookEvent 提炼 PlaybookCandidate。
// 不做任何 IO / DB 写（写是 Curator 责任）；不调 LLM（第一版纯规则 + 启发式）。
//
// 提炼规则（5 类事件 → 4 种 candidate kind）：
// - checkpoint_failed → lesson（confidence=0.9，从 payload.failedAttempts + doNotRepeat）
// - summary_dropped → context（confidence=0.7，从 payload.keyDecisions）+ lesson（confidence=0.5，从 openThreads）
// - outcome_failed → lesson（confidence=0.8，从 payload.failureCode）
// - outcome_needs_user → preference（confidence=0.6，从 payload.interventionKind）
// - outcome_passed / tool_success → skip（避免噪音；不产生 candidate）
//
// 关键不变量：
// - 纯函数：相同输入永远产生相同 candidate 列表（snapshot 测试友好）
// - 失败不抛错：解析失败的 payload → skip 单条 event，不中断整体
// - 每个 candidate 带 sourceEventIds[]（反查 evidence 链）

import type { PlaybookCandidate, PlaybookEvent } from "./types";

interface EventPayload {
  failedAttempts?: string[];
  doNotRepeat?: string[];
  keyDecisions?: string[];
  openThreads?: string[];
  failureCode?: string;
  interventionKind?: string;
}

function safeParsePayload(json: string): EventPayload {
  try {
    return JSON.parse(json) as EventPayload;
  } catch {
    return {};
  }
}

function makeCandidate(args: {
  id: string;
  kind: PlaybookCandidate["kind"];
  title: string;
  content: string;
  importance: number;
  tags: string[];
  sourceKind: PlaybookCandidate["sourceKind"];
  sourceRef: string;
  confidence: number;
  sourceEventIds: string[];
  reason: string;
}): PlaybookCandidate {
  return { ...args };
}

export function reflectPlaybookEvents(events: PlaybookEvent[]): PlaybookCandidate[] {
  const out: PlaybookCandidate[] = [];
  let counter = 0;
  const nextId = () => `cand-${Date.now()}-${++counter}`;

  for (const evt of events) {
    const payload = safeParsePayload(evt.payloadJson);
    switch (evt.kind) {
      case "checkpoint_failed": {
        // 1. failedAttempts → lesson（confidence=0.9）
        for (const item of payload.failedAttempts ?? []) {
          out.push(makeCandidate({
            id: nextId(),
            kind: "lesson",
            title: `从失败中学习：${item.slice(0, 60)}`,
            content: item,
            importance: 70,
            tags: ["checkpoint_failed", "auto_derived"],
            sourceKind: "checkpoint",
            sourceRef: evt.id,
            confidence: 0.9,
            sourceEventIds: [evt.id],
            reason: "checkpoint.failedAttempts 自动提炼",
          }));
        }
        // 2. doNotRepeat → lesson（confidence=0.9）
        for (const item of payload.doNotRepeat ?? []) {
          out.push(makeCandidate({
            id: nextId(),
            kind: "lesson",
            title: `不要重复：${item.slice(0, 60)}`,
            content: item,
            importance: 80,
            tags: ["do_not_repeat", "auto_derived"],
            sourceKind: "checkpoint",
            sourceRef: evt.id,
            confidence: 0.9,
            sourceEventIds: [evt.id],
            reason: "checkpoint.doNotRepeat 自动提炼（高优先级）",
          }));
        }
        break;
      }
      case "summary_dropped": {
        // 1. keyDecisions → context（confidence=0.7）
        for (const item of payload.keyDecisions ?? []) {
          out.push(makeCandidate({
            id: nextId(),
            kind: "context",
            title: `关键决策：${item.slice(0, 60)}`,
            content: item,
            importance: 60,
            tags: ["key_decision", "auto_derived"],
            sourceKind: "summary",
            sourceRef: evt.id,
            confidence: 0.7,
            sourceEventIds: [evt.id],
            reason: "summary.keyDecisions 自动提炼",
          }));
        }
        // 2. openThreads → lesson（confidence=0.5 — open threads 不一定是要记住的 lesson）
        for (const item of payload.openThreads ?? []) {
          out.push(makeCandidate({
            id: nextId(),
            kind: "lesson",
            title: `待解决：${item.slice(0, 60)}`,
            content: item,
            importance: 50,
            tags: ["open_thread", "auto_derived"],
            sourceKind: "summary",
            sourceRef: evt.id,
            confidence: 0.5,
            sourceEventIds: [evt.id],
            reason: "summary.openThreads 自动提炼（低 confidence，需 confirm）",
          }));
        }
        break;
      }
      case "outcome_failed": {
        const code = payload.failureCode ?? "unknown";
        out.push(makeCandidate({
          id: nextId(),
          kind: "lesson",
          title: `失败模式：${code}`,
          content: `节点失败（failureCode=${code}），需要后续验证避免重复。`,
          importance: 70,
          tags: ["failure_code", "auto_derived"],
          sourceKind: "tool_output",
          sourceRef: evt.id,
          confidence: 0.8,
          sourceEventIds: [evt.id],
          reason: "outcome_failed 自动提炼",
        }));
        break;
      }
      case "outcome_needs_user": {
        const kind = payload.interventionKind ?? "needs_user";
        out.push(makeCandidate({
          id: nextId(),
          kind: "preference",
          title: `用户介入模式：${kind}`,
          content: `用户对 ${kind} 类场景有特殊介入习惯（待 confirm 后再沉淀为正式 preference）`,
          importance: 50,
          tags: ["needs_user", "auto_derived"],
          sourceKind: "tool_output",
          sourceRef: evt.id,
          confidence: 0.6,
          sourceEventIds: [evt.id],
          reason: "outcome_needs_user 自动提炼（低 confidence，需 confirm）",
        }));
        break;
      }
      case "tool_success":
      case "outcome_passed":
        // 显式 skip：成功路径不产生 candidate（避免噪音）
        break;
    }
  }

  // 统一加 projectId（candidate 落地时用）
  return out.map((c) => ({ ...c, /* projectId 在 types 里没字段，curator 用 ctx */ } as PlaybookCandidate & { _projectId?: string }));
}

// 注：上面 _projectId 是为了"内部携带"——Curator 入参 ctx.projectId 会覆盖；这个 hack 字段
// 不入 types.ts（避免污染公开契约）。如要传递：调用方把 events[i].projectId 直接交给 curator。
export function projectIdOfEvents(events: PlaybookEvent[]): string {
  return events[0]?.projectId ?? "";
}