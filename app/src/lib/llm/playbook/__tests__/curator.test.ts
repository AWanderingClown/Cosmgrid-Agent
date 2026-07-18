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

  it("内容矛盾 → mark_disputed 老条目 + create 新条目，都要 confirm；新条目携带 supersedesId 关联老条目", () => {
    const out = curateCandidates(
      [makeCandidate({ title: "路由策略", content: "应该走 SmartRouter 评分" })],
      [makeItem({ title: "模型选择", content: "不应该走 SmartRouter 评分" })],
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ action: "mark_disputed", targetId: "mem-1", requiresConfirm: true });
    expect(out[1]).toMatchObject({ action: "create", requiresConfirm: true });
    // 2026-07-17 复检 HIGH 修复：没有这个关联，PlaybookPanel 没法把 disputed 老条目和新
    // candidate 配对展示、联动裁决——用户可能把两边都点"保留"，两条矛盾事实同时 active。
    expect(out[1]!.newItem?.supersedesId).toBe("mem-1");
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

  it("同一批多条 candidate 都跟同一个老条目矛盾 → 各自产生 mark_disputed+create，新条目都携带同一 supersedesId（PlaybookPanel 靠这个分组渲染，见 derive-playbook-groups.test.ts）", () => {
    // existing 内容故意同时含"不应该"和"don't use "两个矛盾关键词，让两条 candidate
    // 各自独立命中 detectConflict 的不同关键词对（"应该/不应该" 和 "prefer /don't use "），
    // 真正验证 curator 对同一批里两条都冲突同一老条目的情况都会各自产生 mark_disputed，
        // 而不是只处理第一条就停手（2026-07-17 三轮复检抓到的测试断言过松，已改用能让两条
    // candidate 都真实触发矛盾判定的 fixture）。
    const out = curateCandidates(
      [
        makeCandidate({ id: "cand-a", title: "路由策略A", content: "应该走 SmartRouter 评分" }),
        makeCandidate({ id: "cand-b", title: "路由策略B", content: "prefer 权重收缩算法" }),
      ],
      [makeItem({ title: "模型选择", content: "不应该走 SmartRouter 评分，don't use 手写权重" })],
    );
    const disputedDecisions = out.filter((d) => d.action === "mark_disputed");
    expect(disputedDecisions).toHaveLength(2);
    expect(disputedDecisions.every((d) => d.targetId === "mem-1")).toBe(true);
    const createDecisions = out.filter((d) => d.action === "create");
    expect(createDecisions).toHaveLength(2);
    expect(createDecisions.every((d) => d.newItem?.supersedesId === "mem-1")).toBe(true);
  });
});
