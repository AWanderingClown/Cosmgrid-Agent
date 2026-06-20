// 痛点 3：消息难度分类 + 按难度派模型 单测
import { describe, it, expect } from "vitest";
import {
  classifyMessageComplexity,
  complexityToTier,
  pickModelForMessage,
  type RoutableModel,
} from "../llm/message-router";

describe("classifyMessageComplexity 消息难度判断", () => {
  it("难活关键词 → hard", () => {
    expect(classifyMessageComplexity("帮我设计一下这个系统的架构")).toBe("hard");
    expect(classifyMessageComplexity("这段代码为什么会崩，帮我排查")).toBe("hard");
    expect(classifyMessageComplexity("refactor this module please")).toBe("hard");
    expect(classifyMessageComplexity("帮我优化这个算法的性能")).toBe("hard");
  });

  it("简单关键词 → simple", () => {
    expect(classifyMessageComplexity("把这句话翻译成英文")).toBe("simple");
    expect(classifyMessageComplexity("这个变量改名叫 userList")).toBe("simple");
    expect(classifyMessageComplexity("translate this to Chinese")).toBe("simple");
  });

  it("很短且无代码 → simple", () => {
    expect(classifyMessageComplexity("你好")).toBe("simple");
    expect(classifyMessageComplexity("谢谢")).toBe("simple");
  });

  it("普通请求 → standard", () => {
    expect(classifyMessageComplexity("帮我写一个登录表单组件，要有邮箱和密码两个输入框")).toBe("standard");
  });

  it("超长消息 → hard（即使没难词）", () => {
    expect(classifyMessageComplexity("写代码 ".repeat(300))).toBe("hard");
  });

  it("含多段代码 → hard", () => {
    const twoBlocks = "看看这两段\n```js\na\n```\n和\n```js\nb\n```";
    expect(classifyMessageComplexity(twoBlocks)).toBe("hard");
  });

  it("难信号优先于简单信号（既短又含难词 → hard）", () => {
    expect(classifyMessageComplexity("为什么")).toBe("hard");
  });
});

describe("complexityToTier 难度→档位", () => {
  it("简单→fast，标准→balanced，难→flagship", () => {
    expect(complexityToTier("simple")).toBe("fast");
    expect(complexityToTier("standard")).toBe("balanced");
    expect(complexityToTier("hard")).toBe("flagship");
  });
});

// 用真实模型名驱动 detectModelTier；capabilityScore 留 null 走名字推断
function model(id: string, name: string): RoutableModel {
  return { id, name, capabilityScore: null, workRoles: "[]" };
}

describe("pickModelForMessage 按消息派模型", () => {
  const opus = model("opus", "claude-opus-4-8"); // flagship
  const sonnet = model("sonnet", "claude-sonnet-4-6"); // balanced
  const haiku = model("haiku", "claude-3-haiku"); // fast
  const all = [opus, sonnet, haiku];

  it("简单消息 → 派便宜档（haiku）", () => {
    const r = pickModelForMessage("把这句翻译一下", all);
    expect(r?.model.id).toBe("haiku");
    expect(r?.complexity).toBe("simple");
  });

  it("标准消息 → 派均衡档（sonnet）", () => {
    const r = pickModelForMessage("帮我写个登录表单组件", all);
    expect(r?.model.id).toBe("sonnet");
  });

  it("难消息 → 派旗舰档（opus）", () => {
    const r = pickModelForMessage("帮我设计这个系统架构", all);
    expect(r?.model.id).toBe("opus");
  });

  it("目标档位缺失时降级：难题但只有便宜模型 → 退而求其次用最强的便宜模型", () => {
    const onlyCheap = [haiku, model("mini", "gpt-4o-mini")];
    const r = pickModelForMessage("帮我设计架构", onlyCheap);
    // flagship/balanced 都没有 → 落到 fast 档
    expect(["haiku", "mini"]).toContain(r?.model.id);
    expect(r?.complexity).toBe("hard");
  });

  it("简单题但只有旗舰模型 → 也能挑出来（不至于没结果）", () => {
    const onlyFlagship = [opus];
    const r = pickModelForMessage("你好", onlyFlagship);
    expect(r?.model.id).toBe("opus");
  });

  it("没有任何模型 → null", () => {
    expect(pickModelForMessage("你好", [])).toBeNull();
  });
});
