// 阶段5 Playbook — Curator 纯函数测试（2026-07-17 接线时补齐，README 计划的 6 case）。

import { describe, expect, it } from "vitest";
import { curateCandidates } from "../curator";
import type { PlaybookCandidate, PlaybookItem } from "../types";

function makeCandidate(over: Partial<PlaybookCandidate>): PlaybookCandidate {
  return {
    id: "cand-1",
    kind: "context",
    title: "关键决策：用 SQLite",
    content: "本项目数据层用 SQLite。",
    importance: 60,
    tags: ["key_decision"],
    sourceKind: "summary",
    sourceRef: "evt-1",
    confidence: 0.7,
    sourceEventIds: ["evt-1"],
    reason: "测试",
    ...over,
  };
}

function makeItem(over: Partial<PlaybookItem>): PlaybookItem {
  return {
    id: "mem-1",
    projectId: "p-1",
    kind: "context",
    title: "关键决策：用 SQLite",
    content: "本项目数据层用 SQLite。",
    importance: 60,
    tags: ["key_decision"],
    sourceKind: "summary",
    sourceRef: null,
    confidence: 0.7,
    status: "active",
    helpfulCount: 0,
    harmfulCount: 0,
    lastUsedAt: null,
    supersedesId: null,
    evidenceRefsJson: null,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    ...over,
  };
}

describe("curateCandidates", () => {
  it("标题完全相同 → skip（幂等挡重：同事件反复消费不重复落库）", () => {
    const out = curateCandidates([makeCandidate({})], [makeItem({})]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ action: "skip", requiresConfirm: false });
  });

  it("标题相似度 ≥0.8 + 同 kind → supersede（requiresConfirm=false）", () => {
    const out = curateCandidates(
      [makeCandidate({ title: "关键决策：用 SQLite3" })],
      [makeItem({ title: "关键决策：用 SQLite" })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ action: "supersede", targetId: "mem-1", requiresConfirm: false });
    expect(out[0]!.newItem?.title).toBe("关键决策：用 SQLite3");
  });

  it("内容矛盾 → mark_disputed 老条目 + create 新条目，都要 confirm", () => {
    const out = curateCandidates(
      [makeCandidate({ title: "路由策略", content: "应该走 SmartRouter 评分" })],
      [makeItem({ title: "模型选择", content: "不应该走 SmartRouter 评分" })],
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ action: "mark_disputed", targetId: "mem-1", requiresConfirm: true });
    expect(out[1]).toMatchObject({ action: "create", requiresConfirm: true });
  });

  it("高 confidence(≥0.95) + kind=context → create 自动入（requiresConfirm=false）", () => {
    const out = curateCandidates([makeCandidate({ title: "新事实", confidence: 0.95 })], []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ action: "create", requiresConfirm: false });
  });

  it("kind !== context（lesson）→ 即使高 confidence 也 requiresConfirm", () => {
    const out = curateCandidates(
      [makeCandidate({ kind: "lesson", title: "不要重复：改 db.execute", confidence: 0.99 })],
      [],
    );
    expect(out[0]).toMatchObject({ action: "create", requiresConfirm: true });
  });

  it("archived 老条目不参与查重（不挡新 candidate）", () => {
    const out = curateCandidates(
      [makeCandidate({})],
      [makeItem({ status: "archived" })],
    );
    expect(out[0]!.action).toBe("create");
  });

  it("candidate 状态条目也参与 exact 查重（2026-07-17 复检 HIGH：防重复消费无限落新行）", () => {
    const out = curateCandidates([makeCandidate({})], [makeItem({ status: "candidate" })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.action).toBe("skip");
  });

  it("用户手建记忆（sourceKind=manual）不被自动 supersede，走 create+confirm", () => {
    const out = curateCandidates(
      [makeCandidate({ title: "关键决策：用 SQLite3" })],
      [makeItem({ title: "关键决策：用 SQLite", sourceKind: "manual" })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ action: "create", requiresConfirm: true });
  });

  it("harmful_count > 3 的条目不参与查重/相似度比较（避免被踩条目挡住新条目的死循环）", () => {
    const out = curateCandidates(
      [makeCandidate({})],
      [makeItem({ harmfulCount: 5 })],
    );
    expect(out[0]!.action).toBe("create");
  });
});
