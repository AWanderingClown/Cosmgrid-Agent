// semantic-cache 单测（v0.9 阶段7：写入过滤 + 余弦命中 + 命中计数）
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  listValid: vi.fn(),
  recordHit: vi.fn(),
  deleteExpired: vi.fn(),
}));

vi.mock("../../db", () => ({
  semanticCache: {
    create: mocks.create,
    listValid: mocks.listValid,
    recordHit: mocks.recordHit,
    deleteExpired: mocks.deleteExpired,
  },
}));

import { lookupCache, writeCache, cleanupExpiredCache, CACHE_TTL_MS } from "../semantic-cache";
import { keywordEmbed, getEmbeddingProvider } from "../embedding";

function row(query: string, response: string, over: Record<string, unknown> = {}) {
  return {
    id: `c-${query}`,
    queryText: query,
    queryEmbedding: keywordEmbed(query),
    responseText: response,
    modelId: "m-1",
    taskType: "standard",
    providerName: "keyword-hash-v2", // 匹配当前 keywordEmbeddingProvider.name
    hitCount: 0,
    lastHitAt: null,
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    createdAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.create.mockResolvedValue(undefined);
  mocks.recordHit.mockResolvedValue(undefined);
  mocks.deleteExpired.mockResolvedValue(undefined);
});

describe("lookupCache", () => {
  it("无缓存时返回 null", async () => {
    mocks.listValid.mockResolvedValue([]);
    expect(await lookupCache("任意")).toBeNull();
  });

  it("命中相同 query → 返回缓存并累加命中", async () => {
    mocks.listValid.mockResolvedValue([row("什么是闭包", "闭包是函数加词法环境")]);
    const hit = await lookupCache("什么是闭包");
    expect(hit).not.toBeNull();
    expect(hit!.responseText).toBe("闭包是函数加词法环境");
    expect(hit!.similarity).toBeGreaterThanOrEqual(0.92);
    expect(mocks.recordHit).toHaveBeenCalledWith(hit!.id);
  });

  it("无关 query 不命中（相似度低于阈值）", async () => {
    mocks.listValid.mockResolvedValue([row("数据库索引优化", "建索引加速查询")]);
    const hit = await lookupCache("今天天气怎么样啊朋友");
    expect(hit).toBeNull();
    expect(mocks.recordHit).not.toHaveBeenCalled();
  });

  it("多条命中取相似度最高", async () => {
    mocks.listValid.mockResolvedValue([
      row("解释闭包概念", "答案A"),
      row("什么是闭包", "答案B"),
    ]);
    const hit = await lookupCache("什么是闭包");
    expect(hit!.responseText).toBe("答案B");
  });

  it("维度不一致的旧缓存被跳过（换过 provider）", async () => {
    mocks.listValid.mockResolvedValue([
      { ...row("什么是闭包", "x"), queryEmbedding: [0.1, 0.2] }, // 错误维度
    ]);
    expect(await lookupCache("什么是闭包")).toBeNull();
  });

  it("provider name 不匹配的旧缓存被跳过（跨算法版本 — HIGH-1 防线）", async () => {
    // 旧版本写入的缓存（如 'keyword-hash'），vec 跟当前 v2 算法不兼容，绝不能命中
    mocks.listValid.mockResolvedValue([
      { ...row("什么是闭包", "旧答案"), providerName: "keyword-hash" },
    ]);
    expect(await lookupCache("什么是闭包")).toBeNull();
    expect(mocks.recordHit).not.toHaveBeenCalled();
  });
});

describe("D9：lookupCache 仅按当前 embedding provider 拉缓存", () => {
  it("listValid 收到 providerName 过滤，避免跨 provider 全表扫描", async () => {
    mocks.listValid.mockResolvedValue([row("什么是闭包", "闭包是函数加词法环境")]);
    await lookupCache("什么是闭包");
    expect(mocks.listValid).toHaveBeenCalledTimes(1);
    const callArg = mocks.listValid.mock.calls[0]![0];
    expect(callArg).toEqual({ providerName: getEmbeddingProvider().name });
  });

  it("DB 层 mock 即便返回别的 provider 的整批 vec，lookup 也不命中（双重防线）", async () => {
    // 即便有人误把 listValid 实现成拉全表，JS 层 providerName 不匹配也会 skip
    mocks.listValid.mockResolvedValue([
      { ...row("什么是闭包", "旧答案"), providerName: "some-other-provider" },
    ]);
    expect(await lookupCache("什么是闭包")).toBeNull();
    expect(mocks.recordHit).not.toHaveBeenCalled();
  });
});

describe("writeCache — 保守过滤", () => {
  it("普通问答写入，expiresAt ≈ now + 7 天 + 带 providerName 标记", async () => {
    const before = Date.now();
    const ok = await writeCache("什么是闭包", "闭包是...", "m-1", "standard");
    expect(ok).toBe(true);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const arg = mocks.create.mock.calls[0]![0];
    const ttl = new Date(arg.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(CACHE_TTL_MS - 5000);
    expect(ttl).toBeLessThan(CACHE_TTL_MS + 5000);
    // 写时带当前 provider name，未来升级 embedding 算法时旧缓存能被识别
    expect(arg.providerName).toBe("keyword-hash-v2");
  });

  it("时间敏感 query 不写", async () => {
    const ok = await writeCache("今天的汇率", "7.1", "m-1", "standard");
    expect(ok).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("答案含代码不写", async () => {
    const ok = await writeCache("写个函数", "```js\nfn(){}\n```", "m-1", "standard");
    expect(ok).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("cleanupExpiredCache", () => {
  it("调用 db deleteExpired", async () => {
    await cleanupExpiredCache();
    expect(mocks.deleteExpired).toHaveBeenCalledTimes(1);
  });
});
