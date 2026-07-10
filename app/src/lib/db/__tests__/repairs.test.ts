import { describe, expect, it } from "vitest";
import { clearIdleLeaderOnlyOrchestration, repairCliPresetModels } from "../repairs";
import type { DatabaseLike } from "../../db-migrations";

interface FakeRow {
  id: string;
  name: string;
  provider_type: string;
  provider_id: string;
}

function makeDb(rows: FakeRow[]): DatabaseLike & { updates: Array<{ id: string; name: string; displayName: string }> } {
  const updates: Array<{ id: string; name: string; displayName: string }> = [];
  return {
    updates,
    select: async <T>(): Promise<T> => rows as unknown as T,
    execute: async (_sql: string, params?: unknown[]) => {
      const [name, displayName, , , , id] = params ?? [];
      updates.push({ id: String(id), name: String(name), displayName: String(displayName) });
      return { rowsAffected: 1 };
    },
  };
}

describe("repairCliPresetModels", () => {
  it("把历史遗留的 Claude CLI 错误名（opus/claude-opus-4-8/sonnet）重命名成具体版本号 claude-sonnet-5", async () => {
    for (const legacyName of ["opus", "claude-opus-4-8", "sonnet"]) {
      const db = makeDb([{ id: "m1", name: legacyName, provider_type: "claude-cli", provider_id: "p1" }]);
      await repairCliPresetModels(db);
      expect(db.updates).toEqual([{ id: "m1", name: "claude-sonnet-5", displayName: "Sonnet 5" }]);
    }
  });

  it("把历史遗留的 Codex CLI 错误名重命名成 gpt-5.5", async () => {
    const db = makeDb([{ id: "m1", name: "gpt5.5-codex", provider_type: "codex-cli", provider_id: "p1" }]);
    await repairCliPresetModels(db);
    expect(db.updates).toEqual([{ id: "m1", name: "gpt-5.5", displayName: "GPT 5.5" }]);
  });

  it("provider 底下已经有 2+ 个模型（多档位方案）时跳过——一行叫 claude-opus-4-8 这时候是正确的 Opus 档位本身，不是历史 bug", async () => {
    const db = makeDb([
      { id: "sonnet-row", name: "claude-sonnet-5", provider_type: "claude-cli", provider_id: "p1" },
      { id: "opus-row", name: "claude-opus-4-8", provider_type: "claude-cli", provider_id: "p1" },
      { id: "haiku-row", name: "claude-haiku-4-5", provider_type: "claude-cli", provider_id: "p1" },
    ]);
    await repairCliPresetModels(db);
    expect(db.updates).toEqual([]);
  });

  it("不认识的模型名（用户自定义）原样跳过，不强行改名", async () => {
    const db = makeDb([{ id: "m1", name: "my-custom-claude-model", provider_type: "claude-cli", provider_id: "p1" }]);
    await repairCliPresetModels(db);
    expect(db.updates).toEqual([]);
  });

  it("非 CLI 供应商的模型完全不受影响（查询本身按 provider type 过滤，这里只验证空结果不报错）", async () => {
    const db = makeDb([]);
    await expect(repairCliPresetModels(db)).resolves.toBeUndefined();
  });
});

// 暴露一个支持任意 SQL 的 fake db 给 clearIdleLeaderOnlyOrchestration 测试用
// —— 这个函数只关心每行 orchestration JSON、UPDATE 时只用一个 id 参数，跟
// repairCliPresetModels 的 UPDATE 模式完全不同。
function makeClearDb(
  rows: Array<{ id: string; orchestration: string | null }>,
): DatabaseLike & { clearedIds: string[] } {
  const clearedIds: string[] = [];
  return {
    clearedIds,
    select: async <T>(): Promise<T> => rows as unknown as T,
    execute: async (_sql: string, params?: unknown[]) => {
      clearedIds.push(String(params?.[0] ?? ""));
      return { rowsAffected: 1 };
    },
  };
}

describe("clearIdleLeaderOnlyOrchestration", () => {
  it("孤立 single-leader 非 pinned 且 chainPlan 为空 → 清空 orchestration", async () => {
    const db = makeClearDb([
      {
        id: "c1",
        orchestration: JSON.stringify({
          nodes: [{ role: "leader", pinned: false }],
          chainPlan: [],
        }),
      },
    ]);
    await clearIdleLeaderOnlyOrchestration(db);
    expect(db.clearedIds).toEqual(["c1"]);
  });

  it("节点是 leader 但是 pinned=true → 不清（用户钉住的，不能误删）", async () => {
    const db = makeClearDb([
      {
        id: "c1",
        orchestration: JSON.stringify({
          nodes: [{ role: "leader", pinned: true }],
          chainPlan: [],
        }),
      },
    ]);
    await clearIdleLeaderOnlyOrchestration(db);
    expect(db.clearedIds).toEqual([]);
  });

  it("节点不是 leader → 不清", async () => {
    const db = makeClearDb([
      {
        id: "c1",
        orchestration: JSON.stringify({
          nodes: [{ role: "architect", pinned: false }],
          chainPlan: [],
        }),
      },
    ]);
    await clearIdleLeaderOnlyOrchestration(db);
    expect(db.clearedIds).toEqual([]);
  });

  it("有 2+ 个节点（非孤立） → 不清", async () => {
    const db = makeClearDb([
      {
        id: "c1",
        orchestration: JSON.stringify({
          nodes: [
            { role: "leader", pinned: false },
            { role: "architect", pinned: false },
          ],
          chainPlan: [],
        }),
      },
    ]);
    await clearIdleLeaderOnlyOrchestration(db);
    expect(db.clearedIds).toEqual([]);
  });

  it("有 chainPlan 在排队 → 不清（pending 状态，不是 idle）", async () => {
    const db = makeClearDb([
      {
        id: "c1",
        orchestration: JSON.stringify({
          nodes: [{ role: "leader", pinned: false }],
          chainPlan: [{ id: "next-step" }],
        }),
      },
    ]);
    await clearIdleLeaderOnlyOrchestration(db);
    expect(db.clearedIds).toEqual([]);
  });

  it("orchestration 是坏 JSON → 跳过该行，不抛错（避免误删用户真实工作链路）", async () => {
    const db = makeClearDb([{ id: "c1", orchestration: "{not-json" }]);
    await expect(clearIdleLeaderOnlyOrchestration(db)).resolves.toBeUndefined();
    expect(db.clearedIds).toEqual([]);
  });

  it("空 orchestration → 不在 SQL WHERE 里命中，db.select 返回空数组，不动", async () => {
    const db = makeClearDb([]);
    await expect(clearIdleLeaderOnlyOrchestration(db)).resolves.toBeUndefined();
    expect(db.clearedIds).toEqual([]);
  });

  it("orchestration 是空对象 {} → nodes 默认 [] / chainPlan 默认 []，组合判定不命中（nodes.length===1 不成立），不清", async () => {
    const db = makeClearDb([
      { id: "c1", orchestration: JSON.stringify({}) },
    ]);
    await clearIdleLeaderOnlyOrchestration(db);
    expect(db.clearedIds).toEqual([]);
  });
});
