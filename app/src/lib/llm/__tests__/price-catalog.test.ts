import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lookupActive: vi.fn(),
  disableSource: vi.fn(),
  create: vi.fn(),
  replaceSourceEntries: vi.fn(),
  disableManualForModel: vi.fn(),
  syncUpsert: vi.fn(),
}));

vi.mock("../../db", () => ({
  modelPriceCatalog: {
    lookupActive: mocks.lookupActive,
    disableSource: mocks.disableSource,
    create: mocks.create,
    replaceSourceEntries: mocks.replaceSourceEntries,
    disableManualForModel: mocks.disableManualForModel,
  },
  priceSyncStatus: {
    upsert: mocks.syncUpsert,
  },
}));

import {
  lookupPriceFromCatalog,
  parseRemotePriceCatalog,
  saveManualModelPrice,
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
