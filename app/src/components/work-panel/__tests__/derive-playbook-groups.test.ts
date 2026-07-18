// PlaybookPanel 分组/pending 过滤纯函数测试（2026-07-17 二轮复检 MEDIUM 修复回归）：
// - 同一 disputed 老条目被多条 candidate 同时冲突时，全部都要能分组展示，不能只取第一条
// - plainCandidates 必须排除所有已配对的 candidate（不止第一条）
// - pending id 过滤：写库途中的条目要从 refetch 结果里排除

import { describe, expect, it } from "vitest";
import { excludePendingIds, groupPlaybookCandidates } from "../derive-playbook-groups";
import type { ProjectMemory } from "@/lib/db/memory";

function makeMemory(over: Partial<ProjectMemory>): ProjectMemory {
  return {
    id: "m-1",
    projectId: "p-1",
    kind: "context",
    title: "标题",
    content: "内容",
    importance: 50,
    tags: null,
    status: "candidate",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    ...over,
  };
}

describe("groupPlaybookCandidates", () => {
  it("单个 disputed 配单个 candidate：正常分组，plainCandidates 不含它", () => {
    const disputed = [makeMemory({ id: "d-1", status: "disputed" })];
    const candidates = [makeMemory({ id: "c-1", supersedesId: "d-1" }), makeMemory({ id: "c-2" })];
    const { groups, plainCandidates } = groupPlaybookCandidates(disputed, candidates);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.linkedCandidates.map((c) => c.id)).toEqual(["c-1"]);
    expect(plainCandidates.map((c) => c.id)).toEqual(["c-2"]);
  });

  it("同一 disputed 被多条 candidate 同时冲突：全部进同一组，都不进 plainCandidates（2026-07-17 二轮复检 MEDIUM 修复）", () => {
    const disputed = [makeMemory({ id: "d-1", status: "disputed" })];
    const candidates = [
      makeMemory({ id: "c-1", supersedesId: "d-1" }),
      makeMemory({ id: "c-2", supersedesId: "d-1" }),
      makeMemory({ id: "c-3" }),
    ];
    const { groups, plainCandidates } = groupPlaybookCandidates(disputed, candidates);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.linkedCandidates.map((c) => c.id).sort()).toEqual(["c-1", "c-2"]);
    expect(plainCandidates.map((c) => c.id)).toEqual(["c-3"]);
  });

  it("disputed 无配对 candidate：linkedCandidates 空数组，不影响其它组", () => {
    const disputed = [makeMemory({ id: "d-1", status: "disputed" }), makeMemory({ id: "d-2", status: "disputed" })];
    const candidates = [makeMemory({ id: "c-1", supersedesId: "d-2" })];
    const { groups, plainCandidates } = groupPlaybookCandidates(disputed, candidates);
    expect(groups.find((g) => g.disputed.id === "d-1")!.linkedCandidates).toEqual([]);
    expect(groups.find((g) => g.disputed.id === "d-2")!.linkedCandidates.map((c) => c.id)).toEqual(["c-1"]);
    expect(plainCandidates).toEqual([]);
  });

  it("candidate.supersedesId 指向不存在的 disputed id（已被裁决离开 disputed 列表）→ 落回 plainCandidates", () => {
    const disputed: ProjectMemory[] = [];
    const candidates = [makeMemory({ id: "c-1", supersedesId: "d-已归档" })];
    const { groups, plainCandidates } = groupPlaybookCandidates(disputed, candidates);
    expect(groups).toEqual([]);
    expect(plainCandidates.map((c) => c.id)).toEqual(["c-1"]);
  });

  it("空输入 → 空分组 + 空候选", () => {
    expect(groupPlaybookCandidates([], [])).toEqual({ groups: [], plainCandidates: [] });
  });
});

describe("excludePendingIds", () => {
  it("过滤掉 pending 集合里的 id", () => {
    const items = [makeMemory({ id: "a" }), makeMemory({ id: "b" }), makeMemory({ id: "c" })];
    const out = excludePendingIds(items, new Set(["b"]));
    expect(out.map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("pending 为空集合 → 原样返回（引用相等，避免无意义重渲染）", () => {
    const items = [makeMemory({ id: "a" })];
    expect(excludePendingIds(items, new Set())).toBe(items);
  });

  it("pending 包含全部 id → 返回空数组", () => {
    const items = [makeMemory({ id: "a" }), makeMemory({ id: "b" })];
    expect(excludePendingIds(items, new Set(["a", "b"]))).toEqual([]);
  });
});
