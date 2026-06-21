import { describe, it, expect } from "vitest";
import {
  isCliProviderType,
  CLI_DEFAULT_PROGRAM,
  buildControlledEnv,
  buildPromptFromMessages,
  buildCliArgs,
  parseClaudeStreamLine,
  parseCodexStreamLine,
  parseCliStreamLine,
} from "../cli-protocol";

describe("isCliProviderType", () => {
  it("识别 CLI 类型", () => {
    expect(isCliProviderType("claude-cli")).toBe(true);
    expect(isCliProviderType("codex-cli")).toBe(true);
  });
  it("API 直连类型不算 CLI", () => {
    expect(isCliProviderType("anthropic")).toBe(false);
    expect(isCliProviderType("openai")).toBe(false);
    expect(isCliProviderType("openai-compatible")).toBe(false);
    expect(isCliProviderType("")).toBe(false);
  });
});

describe("CLI_DEFAULT_PROGRAM", () => {
  it("有默认可执行名", () => {
    expect(CLI_DEFAULT_PROGRAM["claude-cli"]).toBe("claude");
    expect(CLI_DEFAULT_PROGRAM["codex-cli"]).toBe("codex");
  });
});

describe("buildControlledEnv", () => {
  it("抹掉 ANTHROPIC_* 污染变量（cc switch 指向 MiniMax 的根源）", () => {
    const env = buildControlledEnv({
      PATH: "/usr/bin",
      HOME: "/Users/x",
      ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "sk-cp-xxx",
      ANTHROPIC_MODEL: "MiniMax-M3",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "MiniMax-M3[1M]",
    });
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/Users/x");
    expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined();
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(env["ANTHROPIC_MODEL"]).toBeUndefined();
    expect(env["ANTHROPIC_DEFAULT_OPUS_MODEL"]).toBeUndefined();
  });

  it("抹掉 CLAUDE_CODE_* / CLAUDECODE 嵌套会话标记", () => {
    const env = buildControlledEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_AGENT_SDK_VERSION: "0.3",
      LANG: "en_US.UTF-8",
    });
    expect(env["CLAUDECODE"]).toBeUndefined();
    expect(env["CLAUDE_CODE_SESSION_ID"]).toBeUndefined();
    expect(env["CLAUDE_AGENT_SDK_VERSION"]).toBeUndefined();
    expect(env["LANG"]).toBe("en_US.UTF-8");
  });

  it("跳过 undefined 值，不改入参", () => {
    const input = { A: "1", B: undefined };
    const out = buildControlledEnv(input);
    expect(out).toEqual({ A: "1" });
    expect(input.B).toBeUndefined();
  });
});

describe("buildPromptFromMessages", () => {
  it("拼接多轮对话，带角色标签", () => {
    const p = buildPromptFromMessages([
      { role: "system", content: "你是助手" },
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好！" },
      { role: "user", content: "今天天气" },
    ]);
    expect(p).toContain("[System]\n你是助手");
    expect(p).toContain("[User]\n你好");
    expect(p).toContain("[Assistant]\n你好！");
    expect(p.indexOf("[System]")).toBeLessThan(p.indexOf("[User]"));
  });
  it("空数组返回空串", () => {
    expect(buildPromptFromMessages([])).toBe("");
  });
});

describe("buildCliArgs", () => {
  it("claude：stream-json + verbose + 隔离本地配置 + 模型", () => {
    const args = buildCliArgs("claude-cli", "claude-opus-4-8", "hi");
    expect(args).toContain("-p");
    expect(args).toContain("hi");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    // --setting-sources "" 隔离被污染的本地 settings
    const idx = args.indexOf("--setting-sources");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("");
    expect(args).toContain("--model");
    expect(args).toContain("claude-opus-4-8");
  });
  it("claude：模型名空则不传 --model", () => {
    const args = buildCliArgs("claude-cli", "", "hi");
    expect(args).not.toContain("--model");
  });
  it("codex：exec + json", () => {
    const args = buildCliArgs("codex-cli", "gpt-5-codex", "hi");
    expect(args[0]).toBe("exec");
    expect(args).toContain("hi");
    expect(args).toContain("--json");
    expect(args).toContain("--model");
    expect(args).toContain("gpt-5-codex");
  });
});

describe("parseClaudeStreamLine", () => {
  it("assistant 消息 → delta 文本（取 content[].text）", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "HI" }] },
    });
    expect(parseClaudeStreamLine(line)).toEqual([{ kind: "delta", text: "HI" }]);
  });

  it("assistant 多 block 文本 → 多个 delta，跳过非文本 block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "A" },
          { type: "tool_use", id: "x" },
          { type: "text", text: "B" },
        ],
      },
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      { kind: "delta", text: "A" },
      { kind: "delta", text: "B" },
    ]);
  });

  it("result 成功 → usage + done", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: false,
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 5 },
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      { kind: "usage", inputTokens: 3, outputTokens: 5 },
      { kind: "done", finishReason: "end_turn" },
    ]);
  });

  it("result 失败（未登录）→ error 带原文", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      result: "Not logged in · Please run /login",
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      { kind: "error", message: "Not logged in · Please run /login" },
    ]);
  });

  it("rate_limit_event → rate_limit（订阅额度状态）", () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 1782039000, rateLimitType: "five_hour" },
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      { kind: "rate_limit", resetsAt: 1782039000, limitType: "five_hour" },
    ]);
  });

  it("system/init 行被忽略", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-8" });
    expect(parseClaudeStreamLine(line)).toEqual([]);
  });

  it("非 JSON 行容错返回空（CLI 偶尔混日志行）", () => {
    expect(parseClaudeStreamLine("not json at all")).toEqual([]);
    expect(parseClaudeStreamLine("")).toEqual([]);
    expect(parseClaudeStreamLine("   ")).toEqual([]);
  });
});

describe("parseCodexStreamLine", () => {
  it("agent_message → delta", () => {
    const line = JSON.stringify({ type: "agent_message", text: "hello" });
    expect(parseCodexStreamLine(line)).toEqual([{ kind: "delta", text: "hello" }]);
  });
  it("error → error 事件", () => {
    const line = JSON.stringify({ type: "error", message: "quota exceeded" });
    expect(parseCodexStreamLine(line)).toEqual([{ kind: "error", message: "quota exceeded" }]);
  });
  it("非 JSON 容错", () => {
    expect(parseCodexStreamLine("log line")).toEqual([]);
  });
});

describe("parseCliStreamLine 分发", () => {
  it("按 provider 类型选解析器", () => {
    const claudeLine = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "X" }] },
    });
    expect(parseCliStreamLine("claude-cli", claudeLine)).toEqual([{ kind: "delta", text: "X" }]);
    const codexLine = JSON.stringify({ type: "agent_message", text: "Y" });
    expect(parseCliStreamLine("codex-cli", codexLine)).toEqual([{ kind: "delta", text: "Y" }]);
  });
});
