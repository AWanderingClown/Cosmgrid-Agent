import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lookupActive: vi.fn(),
  disableSource: vi.fn(),
  create: vi.fn(),
  replaceSourceEntries: vi.fn(),
  disableManualForModel: vi.fn(),
  countBySource: vi.fn(),
  syncUpsert: vi.fn(),
}));

vi.mock("../../db", () => ({
  modelPriceCatalog: {
    lookupActive: mocks.lookupActive,
    disableSource: mocks.disableSource,
    create: mocks.create,
    replaceSourceEntries: mocks.replaceSourceEntries,
    disableManualForModel: mocks.disableManualForModel,
    countBySource: mocks.countBySource,
  },
  priceSyncStatus: {
    upsert: mocks.syncUpsert,
  },
}));

import {
  lookupPriceFromCatalog,
  parseRemotePriceCatalog,
  saveManualModelPrice,
  syncModelPrices,
} from "../price-catalog";

describe("lookupPriceFromCatalog", () => {
  beforeEach(() => {
    mocks.lookupActive.mockReset();
    mocks.create.mockReset();
  });

  it("优先返回本地目录中的手动价格", async () => {
    mocks.lookupActive.mockResolvedValueOnce({
      id: "1",
      modelName: "custom-model",
      providerType: "openai-compatible",
      inputPer1m: 0.5,
      outputPer1m: 2,
      cacheReadPer1m: null,
      cacheWritePer1m: null,
      contextWindow: 128000,
      source: "manual",
      sourceUrl: null,
      version: "manual:test",
      enabled: true,
      updatedAt: "2026-06-28T00:00:00.000Z",
    });

    await expect(lookupPriceFromCatalog("custom-model", "openai-compatible")).resolves.toMatchObject({
      catalogId: "1",
      input: 0.5,
      output: 2,
      source: "manual",
      version: "manual:test",
    });
  });

  it("目录没命中时回退内置价格", async () => {
    mocks.lookupActive.mockResolvedValueOnce(null);
    mocks.create.mockResolvedValueOnce({
      id: "builtin-1",
      modelName: "gpt-5",
      providerType: null,
      inputPer1m: 5,
      outputPer1m: 20,
      cacheReadPer1m: null,
      cacheWritePer1m: null,
      contextWindow: 400000,
      source: "builtin",
      sourceUrl: "builtin:gpt-5",
      version: "builtin-2026-06-28",
      enabled: true,
      updatedAt: "2026-06-28T00:00:00.000Z",
    });
    await expect(lookupPriceFromCatalog("gpt-5")).resolves.toMatchObject({
      catalogId: "builtin-1",
      input: 5,
      output: 20,
      source: "builtin",
    });
  });
});

describe("parseRemotePriceCatalog", () => {
  it("从 models.dev 样式 JSON 提取价格、缓存价和上下文窗口", () => {
    const rows = parseRemotePriceCatalog({
      openai: {
        models: {
          "openai/gpt-5": {
            id: "openai/gpt-5",
            limit: { context: 400000 },
            cost: { input: 1.25, output: 10, cache_read: 0.125 },
          },
        },
      },
    }, "models.dev:test");

    expect(rows).toEqual([
      {
        modelName: "gpt-5",
        providerType: "openai",
        inputPer1m: 1.25,
        outputPer1m: 10,
        cacheReadPer1m: 0.125,
        cacheWritePer1m: null,
        contextWindow: 400000,
        source: "remote",
        sourceUrl: "https://models.dev/api.json#openai/gpt-5",
        version: "models.dev:test",
      },
    ]);
  });
});

describe("syncModelPrices 残缺响应体检", () => {
  beforeEach(() => {
    mocks.replaceSourceEntries.mockReset();
    mocks.countBySource.mockReset();
    mocks.syncUpsert.mockReset();
  });

  /** 造一份 models.dev 样式 JSON：n 个供应商各带 1 个有价模型。 */
  function fakeCatalog(n: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) {
      out[`prov${i}`] = {
        models: { [`prov${i}/model${i}`]: { id: `prov${i}/model${i}`, cost: { input: 1, output: 2 } } },
      };
    }
    return out;
  }

  function mockFetchOnce(body: unknown): void {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => body }),
    );
  }

  it("完整响应（数量与现有相当）正常替换", async () => {
    mockFetchOnce(fakeCatalog(4960));
    mocks.countBySource.mockResolvedValueOnce(4953);
    mocks.replaceSourceEntries.mockResolvedValueOnce(undefined);

    const result = await syncModelPrices();

    expect(result.ok).toBe(true);
    expect(mocks.replaceSourceEntries).toHaveBeenCalledTimes(1);
  });

  it("残缺响应（4 行 vs 已有 4953）拒绝替换，保住旧数据", async () => {
    mockFetchOnce(fakeCatalog(4));
    mocks.countBySource.mockResolvedValueOnce(4953);

    const result = await syncModelPrices();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("truncated");
    expect(mocks.replaceSourceEntries).not.toHaveBeenCalled();
  });

  it("低于绝对下限（即使库里本来是空的）也拒绝", async () => {
    mockFetchOnce(fakeCatalog(4));
    mocks.countBySource.mockResolvedValueOnce(0);

    const result = await syncModelPrices();

    expect(result.ok).toBe(false);
    expect(mocks.replaceSourceEntries).not.toHaveBeenCalled();
  });
});

describe("saveManualModelPrice", () => {
  beforeEach(() => {
    mocks.disableManualForModel.mockReset();
    mocks.create.mockReset();
  });

  it("先禁用旧手动价，再写入新版本", async () => {
    mocks.create.mockResolvedValueOnce({ id: "manual-1" });
    await saveManualModelPrice({
      modelName: "custom-model",
      providerType: "openai-compatible",
      inputPer1m: 0.5,
      outputPer1m: 2,
    });

    expect(mocks.disableManualForModel).toHaveBeenCalledWith("custom-model", "openai-compatible");
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      modelName: "custom-model",
      providerType: "openai-compatible",
      source: "manual",
    }));
  });
});
