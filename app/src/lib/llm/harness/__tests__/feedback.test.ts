import { describe, it, expect } from "vitest";
import { evaluateHarness, isClean, buildCorrectionPrompt, detectIntentNoToolCall, buildIntentNudgePrompt } from "../feedback";
import type { ReadRecord } from "../verify-claims";

const readOf = (file_path: string): ReadRecord => ({ input: JSON.stringify({ file_path }), status: "success" });

describe("evaluateHarness", () => {
  it("声称读了文件但无 read 记录 → 标为未验证", () => {
    const v = evaluateHarness("我读取了 app/src/lib/db.ts，里面有 19 张表", []);
    expect(v.unverifiedPaths).toContain("app/src/lib/db.ts");
    expect(isClean(v)).toBe(false);
  });

  it("声称读的文件有真实 read 记录 → 干净", () => {
    const v = evaluateHarness("我读取了 app/src/lib/db.ts，里面有 19 张表", [readOf("app/src/lib/db.ts")]);
    expect(v.unverifiedPaths).toEqual([]);
    expect(isClean(v)).toBe(true);
  });

  it("吐伪工具调用文本 → 抓到伪工具名", () => {
    const v = evaluateHarness('<run_command>{"command":"ls"}</run_command>', []);
    expect(v.pseudoToolNames).toContain("run_command");
    expect(isClean(v)).toBe(false);
  });

  it("纯闲聊无违规 → 干净", () => {
    expect(isClean(evaluateHarness("你好，今天天气不错", []))).toBe(true);
  });
});

describe("buildCorrectionPrompt", () => {
  it("干净 verdict → 空串", () => {
    expect(buildCorrectionPrompt({ unverifiedPaths: [], pseudoToolNames: [] }, { hasTools: true })).toBe("");
  });

  it("有工具 + 未验证路径 → 叫模型去真调 read", () => {
    const p = buildCorrectionPrompt({ unverifiedPaths: ["a/b.ts"], pseudoToolNames: [] }, { hasTools: true });
    expect(p).toContain("a/b.ts");
    expect(p).toContain("read");
    expect(p).toContain("真正调用");
  });

  it("无工具 + 未验证路径 → 叫模型别编、让用户贴内容", () => {
    const p = buildCorrectionPrompt({ unverifiedPaths: ["a/b.ts"], pseudoToolNames: [] }, { hasTools: false });
    expect(p).toContain("没有可用的文件工具");
    expect(p).toContain("贴过来");
    expect(p).not.toContain("真正调用 read");
  });

  it("无工具 + 伪工具调用 → 叫模型别再吐工具格式", () => {
    const p = buildCorrectionPrompt({ unverifiedPaths: [], pseudoToolNames: ["run_command"] }, { hasTools: false });
    expect(p).toContain("run_command");
    expect(p).toContain("不要再输出任何工具调用格式");
  });

  it("有工具 + 伪工具调用 → 叫模型改用结构化 tool_call", () => {
    const p = buildCorrectionPrompt({ unverifiedPaths: [], pseudoToolNames: ["view_file"] }, { hasTools: true });
    expect(p).toContain("结构化 tool_call");
  });
});

describe("detectIntentNoToolCall（阶段 H：有意图无工具调用）", () => {
  it("【触发】我先去看一下 foo.ts", () => {
    expect(detectIntentNoToolCall("我先去看一下 foo.ts")).toBe(true);
  });
  it("【触发】让我打开 src 看看", () => {
    expect(detectIntentNoToolCall("让我打开 src 看看")).toBe(true);
  });
  it("【触发】我来处理这个 bug", () => {
    expect(detectIntentNoToolCall("我来处理这个 bug")).toBe(true);
  });
  it("【触发】让我们跑一下 build", () => {
    expect(detectIntentNoToolCall("让我们跑一下 build")).toBe(true);
  });
  it("【触发】让我先查一下 src/lib/db.ts", () => {
    expect(detectIntentNoToolCall("让我先查一下 src/lib/db.ts")).toBe(true);
  });
  it("【不触发】我先回答你的问题（'回答'不是动作动词）", () => {
    expect(detectIntentNoToolCall("我先回答你的问题")).toBe(false);
  });
  it("【不触发】我建议你这样做（无触发词）", () => {
    expect(detectIntentNoToolCall("我建议你这样做")).toBe(false);
  });
  it("【不触发】答案是 42（纯文字）", () => {
    expect(detectIntentNoToolCall("答案是 42")).toBe(false);
  });
  it("【不触发】空字符串", () => {
    expect(detectIntentNoToolCall("")).toBe(false);
  });
  it("【边界】'我看看' 无完整触发词 → 不触发（漏报 OK，漏报优于误报）", () => {
    expect(detectIntentNoToolCall("我看看")).toBe(false);
  });

  // 真实事故补测（2026-07-04）：模型说"再试一次"/"再发一次"完全不带"我先/让我"前缀，
  // 原正则漏检，导致这句空手套白狼直接放行——见 feedback.ts 里 RETRY_NO_TOOL_RE 的注释。
  it("【触发】好，再试一次。（无'我先/让我'前缀的重试语气）", () => {
    expect(detectIntentNoToolCall("好，再试一次。")).toBe(true);
  });
  it("【触发】我这边上一轮发请求好像没返回，再发一次。", () => {
    expect(detectIntentNoToolCall("我这边上一轮发请求好像没返回，再发一次。")).toBe(true);
  });
  it("【触发】重新试一下", () => {
    expect(detectIntentNoToolCall("重新试一下")).toBe(true);
  });
});

describe("buildIntentNudgePrompt（阶段 H：nudge 重答话术）", () => {
  it("非空字符串，含'直接调用'工具 + 解释意图", () => {
    const p = buildIntentNudgePrompt();
    expect(p.length).toBeGreaterThan(0);
    expect(p).toContain("直接调用");
    expect(p).toContain("意图");
  });
  it("跟 buildCorrectionPrompt 话术不同（nudge 是'嘴上说要做'口径，不是'你编了'口径）", () => {
    const nudge = buildIntentNudgePrompt();
    const correction = buildCorrectionPrompt({ unverifiedPaths: ["x.ts"], pseudoToolNames: [] }, { hasTools: true });
    expect(nudge).not.toBe(correction);
    expect(nudge).not.toContain("编造"); // nudge 不说编造
    expect(correction).toContain("编造"); // correction 说编造
  });
});
