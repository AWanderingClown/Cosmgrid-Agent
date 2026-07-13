import { describe, it, expect } from "vitest";
import { parseThinking } from "../parse-thinking";

describe("parseThinking", () => {
  // —— 伪工具调用折叠（M3 实测刷屏元凶，标签名单复用 detect-pseudo-tools）——
  it("XML 标签包 JSON 的伪工具调用 → tool 段（M3 实测格式）", () => {
    const segs = parseThinking('<run_command>{"command":"ls"}</run_command>');
    expect(segs).toEqual([
      { type: "tool", content: '{"command":"ls"}', closed: true },
    ]);
  });

  it("view_file / update_plan 标签也折叠", () => {
    const segs = parseThinking(
      '<view_file>{"file_path":"/x"}</view_file><update_plan>{"plan":"..."}</update_plan>',
    );
    expect(segs).toEqual([
      { type: "tool", content: '{"file_path":"/x"}', closed: true },
      { type: "tool", content: '{"plan":"..."}', closed: true },
    ]);
  });

  it("正文 + 伪工具标签 + 正文 交替", () => {
    const segs = parseThinking(
      '我先看一下文件<run_command>{"command":"cat a"}</run_command>这是结果',
    );
    expect(segs).toEqual([
      { type: "text", content: "我先看一下文件", closed: true },
      { type: "tool", content: '{"command":"cat a"}', closed: true },
      { type: "text", content: "这是结果", closed: true },
    ]);
  });

  it("带属性的伪工具标签也折叠（<run_command foo=\"x\">）", () => {
    const segs = parseThinking('<run_command foo="x">{"command":"ls"}</run_command>');
    expect(segs).toEqual([
      { type: "tool", content: '{"command":"ls"}', closed: true },
    ]);
  });

  // UI 修复（2026-07-02，用户反馈）：博弈过程不该跟最终判断平铺刷屏，debate-result.ts
  // 主动包 <debate_process> 标签，这里验证能正确识别并折叠。
  it("<debate_process> 标签 → debate 段，最终判断（标签外的正文）保持展开", () => {
    const segs = parseThinking(
      "最终判断：先低风险按职责拆。\n\n<debate_process>\n### 1. MiniMax · Solver\n可以拆。\n</debate_process>",
    );
    expect(segs).toEqual([
      { type: "text", content: "最终判断：先低风险按职责拆。\n\n", closed: true },
      { type: "debate", content: "\n### 1. MiniMax · Solver\n可以拆。\n", closed: true },
    ]);
  });

  it("裸 JSON 式伪工具调用 → tool 段", () => {
    const segs = parseThinking('{"name":"run_command","arguments":{"command":"pwd"}}');
    expect(segs).toEqual([
      { type: "tool", content: '{"name":"run_command","arguments":{"command":"pwd"}}', closed: true },
    ]);
  });

  it("正常代码 function foo() {} 不被误折成 tool", () => {
    const segs = parseThinking("function foo() { return 1; }");
    expect(segs).toEqual([
      { type: "text", content: "function foo() { return 1; }", closed: true },
    ]);
  });

  it("纯正文不含思考标签 → 单个 text 段", () => {
    expect(parseThinking("你好，世界")).toEqual([
      { type: "text", content: "你好，世界", closed: true },
    ]);
  });

  it("空字符串 → 空数组", () => {
    expect(parseThinking("")).toEqual([]);
  });

  it("闭合的 <think> 块切成 think + text", () => {
    const segs = parseThinking("<think>先想一下</think>这是答案");
    expect(segs).toEqual([
      { type: "think", content: "先想一下", closed: true },
      { type: "text", content: "这是答案", closed: true },
    ]);
  });

  it("思考块前有正文 → text 在前", () => {
    const segs = parseThinking("引言<think>推理</think>结论");
    expect(segs).toEqual([
      { type: "text", content: "引言", closed: true },
      { type: "think", content: "推理", closed: true },
      { type: "text", content: "结论", closed: true },
    ]);
  });

  it("流式中未闭合的 <think> → 标记 closed=false", () => {
    const segs = parseThinking("<think>还在想");
    expect(segs).toEqual([{ type: "think", content: "还在想", closed: false }]);
  });

  it("支持 <thinking> 标签", () => {
    const segs = parseThinking("<thinking>reason</thinking>done");
    expect(segs).toEqual([
      { type: "think", content: "reason", closed: true },
      { type: "text", content: "done", closed: true },
    ]);
  });

  it("多个思考块交替 → 聚合成一个 think 段（steps:2）提到最前，正文顺序保持", () => {
    const segs = parseThinking("a<think>x</think>b<think>y</think>c");
    expect(segs).toEqual([
      { type: "think", content: "x\n\n─── 步骤 2 ───\n\ny", closed: true, steps: 2 },
      { type: "text", content: "a", closed: true },
      { type: "text", content: "b", closed: true },
      { type: "text", content: "c", closed: true },
    ]);
  });

  it("连续思考块合并成一个折叠块", () => {
    const segs = parseThinking("<think>第一段</think>\n<thinking>第二段</thinking>");
    expect(segs).toEqual([
      { type: "think", content: "第一段\n第二段", closed: true },
    ]);
  });

  // UI 修复（满屏思考折叠块反馈）：中间隔着正文的多个 think 段会聚合成一个块、
  // 提到消息最前面，避免一条回复碎成几十个"思考过程"折叠块。正文顺序保持不变。
  it("中间有正文的多个思考块聚合成一个，提到最前，正文顺序不变", () => {
    const segs = parseThinking("<think>先想</think>这是正文<think>再想</think>");
    expect(segs).toEqual([
      { type: "think", content: "先想\n\n─── 步骤 2 ───\n\n再想", closed: true, steps: 2 },
      { type: "text", content: "这是正文", closed: true },
    ]);
  });

  it("只有一个思考块时不聚合、不加 steps", () => {
    const segs = parseThinking("引言<think>推理</think>结论");
    expect(segs).toEqual([
      { type: "text", content: "引言", closed: true },
      { type: "think", content: "推理", closed: true },
      { type: "text", content: "结论", closed: true },
    ]);
  });

  it("多个思考块聚合时，只要有一段未闭合，合并块整体标记 closed=false（流式中仍显示思考中）", () => {
    const segs = parseThinking("a<think>x</think>b<think>还在想");
    expect(segs).toEqual([
      { type: "think", content: "x\n\n─── 步骤 2 ───\n\n还在想", closed: false, steps: 2 },
      { type: "text", content: "a", closed: true },
      { type: "text", content: "b", closed: true },
    ]);
  });

  it("嵌套 think（按外层成对处理，不被内层提前关闭）", () => {
    const segs = parseThinking("<think>外<think>内</think>still</think>tail");
    expect(segs).toEqual([
      { type: "think", content: "外<think>内</think>still", closed: true },
      { type: "text", content: "tail", closed: true },
    ]);
  });
});
