import { describe, expect, it } from "vitest";
import { repairCliPresetModels } from "../repairs";
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
