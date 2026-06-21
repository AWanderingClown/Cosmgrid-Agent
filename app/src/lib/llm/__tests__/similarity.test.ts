// similarity 单测（v0.9 阶段7：余弦相似度 + 缓存安全过滤）
import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  isTimeSensitive,
  containsCode,
  isCacheable,
  SIMILARITY_THRESHOLD,
} from "../similarity";

describe("cosineSimilarity", () => {
  it("同向量 = 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("正交向量 = 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("反向向量 = -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it("成比例向量 = 1（只看方向不看模长）", () => {
    expect(cosineSimilarity([1, 1], [2, 2])).toBeCloseTo(1, 10);
  });

  it("零向量返回 0（不除零）", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("长度不一致抛错", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow();
  });
});

describe("isTimeSensitive", () => {
  it.each([
    "今天天气怎么样",
    "最新的股价",
    "现在几点",
    "what is the latest news",
    "today's price",
  ])("时间敏感：%s", (t) => {
    expect(isTimeSensitive(t)).toBe(true);
  });

  it.each([
    "帮我写一个排序函数",
    "解释什么是闭包",
    "how does recursion work",
  ])("非时间敏感：%s", (t) => {
    expect(isTimeSensitive(t)).toBe(false);
  });
});

describe("containsCode", () => {
  it("含围栏代码块 → true", () => {
    expect(containsCode("看这段\n```js\nconst a=1\n```")).toBe(true);
  });

  it("含 diff 标记 → true", () => {
    expect(containsCode("diff:\n- old\n+ new")).toBe(true);
  });

  it("纯文字 → false", () => {
    expect(containsCode("这是一段普通解释文字")).toBe(false);
  });
});

describe("isCacheable — 保守接入：时间敏感 / 代码答案不缓存", () => {
  it("普通问答可缓存", () => {
    expect(isCacheable("什么是闭包", "闭包是函数加其词法环境")).toBe(true);
  });

  it("时间敏感 query 不缓存", () => {
    expect(isCacheable("今天的汇率", "1 美元约 7 元")).toBe(false);
  });

  it("答案含代码不自动缓存（避免上下文略异给错代码）", () => {
    expect(isCacheable("写个函数", "```js\nfn(){}\n```")).toBe(false);
  });
});

describe("SIMILARITY_THRESHOLD", () => {
  it("默认 0.92", () => {
    expect(SIMILARITY_THRESHOLD).toBe(0.92);
  });
});
