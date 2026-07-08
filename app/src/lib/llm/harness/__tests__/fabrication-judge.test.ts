import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
}));

vi.mock("ai", () => ({
  generateObject: mocks.generateObject,
}));

const { shouldJudgeFabrication, judgeFabrication } = await import("../fabrication-judge");

const model = { modelId: "judge-model" } as never;

const LONG = "我刚在 example.db 里实际跑了一次查询，person 表有 3 条记录，身份证 130421 被识别为泄露，8ms 完成。";

describe("shouldJudgeFabrication 门控", () => {
  const base = { regexClean: true, finishReason: "stop", toolCallCount: 0, content: LONG };

  it("正则全 clean + stop + 0 工具 + 正文够长 → 进裁判", () => {
    expect(shouldJudgeFabrication(base)).toBe(true);
  });

  it("正则已命中（regexClean=false）→ 走原路，不重复判", () => {
    expect(shouldJudgeFabrication({ ...base, regexClean: false })).toBe(false);
  });

  it("finishReason 非 stop（被截断/中断）→ 不判（那是中断不是编造）", () => {
    expect(shouldJudgeFabrication({ ...base, finishReason: "length" })).toBe(false);
    expect(shouldJudgeFabrication({ ...base, finishReason: null })).toBe(false);
  });

  it("有真实工具调用（toolCallCount>0）→ 不进这条兜底", () => {
    expect(shouldJudgeFabrication({ ...base, toolCallCount: 1 })).toBe(false);
  });

  it("正文过短 → 塞不下具体结果，省掉一次调用", () => {
    expect(shouldJudgeFabrication({ ...base, content: "好的。" })).toBe(false);
  });
});

describe("judgeFabrication LLM 裁判", () => {
  beforeEach(() => vi.clearAllMocks());

  it("编造执行结果 → fabricated=true 原样返回", async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        fabricated: true,
        confidence: 0.95,
        claimedActions: ["查询了 example.db"],
        reason: "给出了只有真查才有的具体命中和耗时。",
      },
    });
    const r = await judgeFabrication(LONG, model);
    expect(r.fabricated).toBe(true);
    expect(r.claimedActions).toContain("查询了 example.db");
    expect(mocks.generateObject).toHaveBeenCalledTimes(1);
    // prompt 必须告知裁判「本轮 0 工具调用」这个前提
    expect(mocks.generateObject.mock.calls[0][0].prompt).toContain("没有任何真实工具调用");
  });

  it("讲通用原理不算编造 → fabricated=false", async () => {
    mocks.generateObject.mockResolvedValue({
      object: { fabricated: false, confidence: 0.9, claimedActions: [], reason: "只是通用讲解。" },
    });
    const r = await judgeFabrication("这类泄露查询工具一般用本地数据库做匹配。", model);
    expect(r.fabricated).toBe(false);
  });

  it("裁判自身调用失败 → 放行（不因兜底层故障阻断正常回答）", async () => {
    mocks.generateObject.mockRejectedValue(new Error("judge boom"));
    const r = await judgeFabrication(LONG, model);
    expect(r.fabricated).toBe(false);
    expect(r.confidence).toBe(0);
  });
});
