// 阶段5 Playbook — 接线管道测试（2026-07-17 断点①②接线 + 同日 Curator 确认 UI 补全）。
//
// 覆盖落库纪律：
// - requiresConfirm=false → status='active'；true → status='candidate'（不入 prompt，
//   等 PlaybookPanel 确认 UI 转正/拒绝）
// - supersede → create 新条目（带 supersedesId）+ markSuperseded 老条目
// - mark_disputed/mark_archived 真执行（PlaybookPanel 冲突裁决区承接后续 markActive/markArchived）
// - checkpoint 断链回归：无 conversationId 时走 project 级消费
// - 任何 DB 抛错 → 返回 null 不上抛（旁路语义）

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  listByConversation: vi.fn(),
  listEventsByProject: vi.fn(),
  create: vi.fn(),
  markSuperseded: vi.fn(),
  markDisputed: vi.fn(),
  markArchived: vi.fn(),
  listMemoriesByProject: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  playbookEvents: {
    record: mocks.record,
    listByConversation: mocks.listByConversation,
    listByProject: mocks.listEventsByProject,
  },
}));

vi.mock("@/lib/db/memory", () => ({
  projectMemories: {
    create: mocks.create,
    markSuperseded: mocks.markSuperseded,
    markDisputed: mocks.markDisputed,
    markArchived: mocks.markArchived,
    listByProject: mocks.listMemoriesByProject,
  },
}));

const {
  applyCuratorDecisions,
  projectMemoryToPlaybookItem,
  recordPlaybookEventSafe,
  runPlaybookPipeline,
} = await import("../pipeline");
import type { CuratorDecision } from "../types";

const newItem: NonNullable<CuratorDecision["newItem"]> = {
  projectId: "",
  kind: "lesson",
  title: "不要重复：改 db.execute",
  content: "会顶掉测试 mock。",
  importance: 80,
  tags: ["do_not_repeat"],
  sourceKind: "checkpoint",
  sourceRef: "evt-1",
  confidence: 0.9,
  status: "active",
  supersedesId: null,
  evidenceRefsJson: '["evt-1"]',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ id: "new-mem-1" });
});

describe("applyCuratorDecisions", () => {
  it("create + requiresConfirm=true → 落 candidate；false → 落 active", async () => {
    const stats = await applyCuratorDecisions("p-1", [
      { action: "create", newItem, reason: "", requiresConfirm: true },
      { action: "create", newItem: { ...newItem, title: "另一条" }, reason: "", requiresConfirm: false },
    ]);
    expect(stats).toMatchObject({ created: 1, candidates: 1 });
    expect(mocks.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: "candidate", projectId: "p-1" }));
    expect(mocks.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: "active" }));
  });

  it("supersede → create 新条目（supersedesId）+ markSuperseded(targetId, newId)", async () => {
    const stats = await applyCuratorDecisions("p-1", [
      { action: "supersede", targetId: "old-1", newItem, reason: "", requiresConfirm: false },
    ]);
    expect(stats.superseded).toBe(1);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ supersedesId: "old-1", status: "active" }));
    expect(mocks.markSuperseded).toHaveBeenCalledWith("old-1", "new-mem-1");
  });

  it("普通 create 转发 newItem.supersedesId（2026-07-17 复检 HIGH 修复：disputed 配对 candidate 靠这个关联字段，漏转发 PlaybookPanel 就配不上对）", async () => {
    await applyCuratorDecisions("p-1", [
      {
        action: "create",
        newItem: { ...newItem, supersedesId: "disputed-old-1" },
        reason: "",
        requiresConfirm: true,
      },
    ]);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ supersedesId: "disputed-old-1", status: "candidate" }));
    // 不该走 markSuperseded——这只是关联引用，不是真的 supersede 老条目
    expect(mocks.markSuperseded).not.toHaveBeenCalled();
  });

  it("mark_disputed / mark_archived 真执行（确认 UI 承接裁决）；skip 不落库", async () => {
    const stats = await applyCuratorDecisions("p-1", [
      { action: "mark_disputed", targetId: "old-1", reason: "", requiresConfirm: true },
      { action: "mark_archived", targetId: "old-2", reason: "", requiresConfirm: true },
      { action: "skip", reason: "", requiresConfirm: false },
    ]);
    expect(stats).toMatchObject({ disputed: 1, archived: 1, skipped: 1 });
    expect(mocks.markDisputed).toHaveBeenCalledWith("old-1");
    expect(mocks.markArchived).toHaveBeenCalledWith("old-2");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("runPlaybookPipeline", () => {
  const failedEvent = {
    id: "evt-1",
    projectId: "p-1",
    conversationId: "conv-1",
    messageId: null,
    kind: "outcome_failed" as const,
    payloadJson: JSON.stringify({ failureCode: "no_tool_evidence" }),
    occurredAt: "2026-07-17T00:00:00.000Z",
    createdAt: "2026-07-17T00:00:00.000Z",
  };

  it("传 conversationId → 消费对话事件并按纪律落库", async () => {
    mocks.listByConversation.mockResolvedValue([failedEvent]);
    mocks.listMemoriesByProject.mockResolvedValue([]);
    const stats = await runPlaybookPipeline({ projectId: "p-1", conversationId: "conv-1" });
    // outcome_failed → lesson(0.8) → requiresConfirm=true → candidate
    expect(stats).toMatchObject({ candidates: 1 });
    expect(mocks.listByConversation).toHaveBeenCalledWith("conv-1", 50);
    expect(mocks.listEventsByProject).not.toHaveBeenCalled();
  });

  it("不传 conversationId → project 级消费（checkpoint 事件断链回归）", async () => {
    mocks.listEventsByProject.mockResolvedValue([{ ...failedEvent, conversationId: null }]);
    mocks.listMemoriesByProject.mockResolvedValue([]);
    const stats = await runPlaybookPipeline({ projectId: "p-1" });
    expect(stats).toMatchObject({ candidates: 1 });
    expect(mocks.listEventsByProject).toHaveBeenCalledWith("p-1", 50);
  });

  it("无事件 / 无候选 → 返回 null 不查 existing", async () => {
    mocks.listByConversation.mockResolvedValue([]);
    const out = await runPlaybookPipeline({ projectId: "p-1", conversationId: "conv-1" });
    expect(out).toBeNull();
    expect(mocks.listMemoriesByProject).not.toHaveBeenCalled();
  });

  it("DB 抛错 → 旁路吞掉返回 null（不上抛阻塞主流程）", async () => {
    mocks.listByConversation.mockRejectedValue(new Error("db locked"));
    const out = await runPlaybookPipeline({ projectId: "p-1", conversationId: "conv-1" });
    expect(out).toBeNull();
  });

  it("幂等回归（2026-07-17 复检 HIGH）：同一事件二次消费，已落的 candidate 行挡住重复 create", async () => {
    mocks.listByConversation.mockResolvedValue([failedEvent]);
    // 第一轮：库里为空 → 落 1 条 candidate
    mocks.listMemoriesByProject.mockResolvedValueOnce([]);
    const first = await runPlaybookPipeline({ projectId: "p-1", conversationId: "conv-1" });
    expect(first).toMatchObject({ candidates: 1 });
    const createdInput = mocks.create.mock.calls[0]![0] as { title: string; kind: string };

    // 第二轮：库里已有那条 status='candidate' 的行（模拟真实回读）
    mocks.listMemoriesByProject.mockResolvedValueOnce([
      {
        id: "mem-c1",
        projectId: "p-1",
        kind: createdInput.kind,
        title: createdInput.title,
        content: "c",
        importance: 70,
        tags: null,
        status: "candidate",
        helpfulCount: 0,
        harmfulCount: 0,
        createdAt: "2026-07-17T00:00:00.000Z",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
    ]);
    mocks.create.mockClear();
    const second = await runPlaybookPipeline({ projectId: "p-1", conversationId: "conv-1" });
    expect(second).toMatchObject({ candidates: 0, created: 0, skipped: 1 });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("端到端冲突配对：新 candidate 与已有 active 条目内容矛盾 → markDisputed 老条目 + create 新条目携带 supersedesId 指回老条目", async () => {
    const summaryDroppedEvent = {
      id: "evt-summary-1",
      projectId: "p-1",
      conversationId: "conv-1",
      messageId: null,
      kind: "summary_dropped" as const,
      payloadJson: JSON.stringify({ keyDecisions: ["应该用 SmartRouter 评分选模型"], openThreads: [] }),
      occurredAt: "2026-07-17T00:00:00.000Z",
      createdAt: "2026-07-17T00:00:00.000Z",
    };
    mocks.listByConversation.mockResolvedValue([summaryDroppedEvent]);
    mocks.listMemoriesByProject.mockResolvedValue([
      {
        id: "old-active-1",
        projectId: "p-1",
        kind: "context",
        title: "模型选择策略",
        content: "不应该用 SmartRouter 评分选模型",
        importance: 60,
        tags: null,
        status: "active",
        helpfulCount: 0,
        harmfulCount: 0,
        createdAt: "2026-07-17T00:00:00.000Z",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
    ]);

    const stats = await runPlaybookPipeline({ projectId: "p-1", conversationId: "conv-1" });
    expect(stats).toMatchObject({ disputed: 1 });
    expect(mocks.markDisputed).toHaveBeenCalledWith("old-active-1");
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ supersedesId: "old-active-1", status: "candidate" }),
    );
  });
});

describe("recordPlaybookEventSafe / projectMemoryToPlaybookItem", () => {
  it("事件写入失败旁路吞掉不抛", async () => {
    mocks.record.mockRejectedValue(new Error("db locked"));
    await expect(
      recordPlaybookEventSafe({
        projectId: "p-1",
        conversationId: null,
        messageId: null,
        kind: "checkpoint_failed",
        payload: { doNotRepeat: ["x"] },
      }),
    ).resolves.toBeUndefined();
  });

  it("ProjectMemory → PlaybookItem：CSV tags 拆数组、未知 kind 归 other、缺省字段兜底", () => {
    const item = projectMemoryToPlaybookItem({
      id: "m-1",
      projectId: "p-1",
      kind: "weird-kind",
      title: "t",
      content: "c",
      importance: 50,
      tags: "a, b,,c",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    });
    expect(item.kind).toBe("other");
    expect(item.tags).toEqual(["a", "b", "c"]);
    expect(item).toMatchObject({ status: "active", confidence: 0.5, helpfulCount: 0 });
  });
});
