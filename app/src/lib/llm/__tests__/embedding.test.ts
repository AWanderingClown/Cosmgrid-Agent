// embedding 单测（v0.9 阶段7：关键词哈希向量化）
import { describe, it, expect } from "vitest";
import { keywordEmbed, tokenize, keywordEmbeddingProvider } from "../embedding";
import { cosineSimilarity } from "../similarity";

describe("tokenize", () => {
  it("拉丁词按词切分", () => {
    expect(tokenize("Hello World")).toContain("hello");
    expect(tokenize("Hello World")).toContain("world");
  });

  it("CJK 出单字 + 二元组", () => {
    const toks = tokenize("排序");
    expect(toks).toContain("排");
    expect(toks).toContain("序");
    expect(toks).toContain("排序");
  });
});

describe("keywordEmbed", () => {
  it("维度固定", () => {
    expect(keywordEmbed("任意文本")).toHaveLength(256);
    expect(keywordEmbed("abc", 64)).toHaveLength(64);
  });

  it("确定性：同文本同向量", () => {
    expect(keywordEmbed("帮我写排序函数")).toEqual(keywordEmbed("帮我写排序函数"));
  });

  it("L2 归一化（模长≈1）", () => {
    const v = keywordEmbed("一些中文内容 and english");
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("空文本 → 零向量（模长 0）", () => {
    const v = keywordEmbed("   ");
    expect(v.every((x) => x === 0)).toBe(true);
  });
});

describe("语义相近度（余弦）", () => {
  it("同义改写相似度高于无关文本", () => {
    const a = keywordEmbed("帮我写一个快速排序函数");
    const b = keywordEmbed("写个快速排序函数");
    const c = keywordEmbed("今天北京的天气预报");
    const simAB = cosineSimilarity(a, b);
    const simAC = cosineSimilarity(a, c);
    expect(simAB).toBeGreaterThan(simAC);
    expect(simAB).toBeGreaterThan(0.5);
  });

  it("完全相同文本余弦 = 1", () => {
    const a = keywordEmbed("数据库索引优化");
    expect(cosineSimilarity(a, keywordEmbed("数据库索引优化"))).toBeCloseTo(1, 10);
  });
});

describe("keywordEmbeddingProvider", () => {
  it("name/dim 正确，embed 返回向量", async () => {
    expect(keywordEmbeddingProvider.name).toBe("keyword-hash");
    expect(keywordEmbeddingProvider.dim).toBe(256);
    const v = await keywordEmbeddingProvider.embed("test");
    expect(v).toHaveLength(256);
  });
});
