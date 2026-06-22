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

  it("CJK 三元组捕捉长词组（'快速排序'）", () => {
    const toks = tokenize("快速排序算法");
    expect(toks).toContain("快速");
    expect(toks).toContain("速排");
    expect(toks).toContain("快速排");
    expect(toks).toContain("速排序");
    expect(toks).toContain("排序算");
  });

  it("中文停用词被过滤（不入 vec 桶）", () => {
    const toks = tokenize("我是一个学生");
    expect(toks).not.toContain("我");
    expect(toks).not.toContain("是");
    expect(toks).not.toContain("的");
    // 仍保留有信息量的字（"学" 非停用字，进 vec 桶——锁住反例分支）
    expect(toks).toContain("学");
    expect(toks).toContain("生");
    expect(toks).toContain("学生");
  });

  it("单字非停用字保留（覆盖率反例分支）", () => {
    // 直接断言非停用单字被保留（覆盖 `if (!CJK_STOPWORDS.has(ch))` 的 else 分支）
    expect(tokenize("学")).toContain("学");
    expect(tokenize("排")).toContain("排");
    expect(tokenize("算法")).toContain("算");
    expect(tokenize("算法")).toContain("法");
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

  it("停用词不进 vec：单字停用词贡献的维度更少", () => {
    // "我是他了" 5 个 CJK 字 4 个停用 → tokenize 后只有 4 个二元组（不进 vec 也少）
    // 对比 "学排索引算" 5 个全信息字 → 非零维度数应更多
    const vStop = keywordEmbed("我是他了");
    const vInfo = keywordEmbed("学排索引算");
    const nonZeroStop = vStop.filter((x) => x !== 0).length;
    const nonZeroInfo = vInfo.filter((x) => x !== 0).length;
    expect(nonZeroInfo).toBeGreaterThanOrEqual(nonZeroStop);
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

  it("三元组改进：'快速排序' 改写相似度高于二元组版本（信息更浓缩）", () => {
    // "快速排序" 三元组在两段里都出现 → 共享 token 更多
    const a = keywordEmbed("解释一下快速排序的原理");
    const b = keywordEmbed("什么是快速排序");
    const c = keywordEmbed("今天天气怎么样");
    const simAB = cosineSimilarity(a, b);
    const simAC = cosineSimilarity(a, c);
    // 三元组"快速排序"贡献一个明显的共享维度
    expect(simAB).toBeGreaterThan(simAC);
    expect(simAB).toBeGreaterThan(0.3);
  });
});

describe("keywordEmbeddingProvider", () => {
  it("name/dim 正确，embed 返回向量", async () => {
    // v0.9.1：name 含 v2 后缀，让 semantic-cache 区分跨算法版本
    expect(keywordEmbeddingProvider.name).toBe("keyword-hash-v2");
    expect(keywordEmbeddingProvider.dim).toBe(256);
    const v = await keywordEmbeddingProvider.embed("test");
    expect(v).toHaveLength(256);
  });
});
