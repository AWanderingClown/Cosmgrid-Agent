import { beforeEach, describe, expect, it, vi } from "vitest";

const persistedRows: Array<{ modelId: string; failures: number; cooldownUntil: string | null; updatedAt: string }> = [];

vi.mock("@/lib/db/model-cooldowns", () => ({
  modelCooldowns: {
    listByModelIds: vi.fn(async (modelIds: readonly string[]) =>
      persistedRows.filter((row) => modelIds.includes(row.modelId))
    ),
    upsert: vi.fn(async (row: { modelId: string; failures: number; cooldownUntil: string | null }) => {
      const index = persistedRows.findIndex((item) => item.modelId === row.modelId);
      const next = { ...row, updatedAt: "2026-07-08T00:00:00.000Z" };
      if (index >= 0) persistedRows[index] = next;
      else persistedRows.push(next);
    }),
    clear: vi.fn(async (modelId: string) => {
      const index = persistedRows.findIndex((row) => row.modelId === modelId);
      if (index >= 0) persistedRows.splice(index, 1);
    }),
  },
}));

import { _resetCooldowns, hydrateModelCooldowns, isInCooldown, markModelFailed, markModelSucceeded } from "../model-cooldown";

describe("model cooldown persistence", () => {
  beforeEach(() => {
    persistedRows.length = 0;
    _resetCooldowns();
  });

  it("hydrates active cooldown rows so restarted scheduling still skips the model", async () => {
    persistedRows.push({
      modelId: "claude-cli",
      failures: 2,
      cooldownUntil: new Date(Date.now() + 300_000).toISOString(),
      updatedAt: "2026-07-08T00:00:00.000Z",
    });

    await hydrateModelCooldowns(["claude-cli"]);

    expect(isInCooldown("claude-cli")).toBe(true);
  });

  it("persists failures and clears persisted state after success", async () => {
    markModelFailed("codex-cli");

    expect(persistedRows[0]).toMatchObject({ modelId: "codex-cli", failures: 1 });
    expect(isInCooldown("codex-cli")).toBe(true);

    markModelSucceeded("codex-cli");

    expect(isInCooldown("codex-cli")).toBe(false);
    expect(persistedRows).toEqual([]);
  });
});
