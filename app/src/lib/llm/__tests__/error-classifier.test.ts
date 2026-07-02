import { describe, it, expect } from "vitest";
import {
  sanitizeError,
  classifyLlmError,
  asClassifiedError,
  type ClassifiedLlmError,
} from "../error-classifier";

describe("sanitizeError", () => {
  it("剥离 Anthropic API Key", () => {
    const msg = "Invalid auth: sk-ant-api03-xxxxxxxxxxxx";
    expect(sanitizeError(msg)).not.toContain("sk-ant");
    expect(sanitizeError(msg)).toContain("[REDACTED]");
  });

  it("剥离 OpenAI project key", () => {
    const msg = "Error: sk-proj-abc123DEF456";
    expect(sanitizeError(msg)).toContain("[REDACTED]");
    expect(sanitizeError(msg)).not.toContain("sk-proj");
  });

  it("null/undefined 返回空字符串", () => {
    expect(sanitizeError(null)).toBe("");
    expect(sanitizeError(undefined)).toBe("");
  });

  it("没有 key 的消息原样返回", () => {
    expect(sanitizeError("Network error")).toBe("Network error");
  });
});

describe("classifyLlmError", () => {
  it("401 → auth_invalid", () => {
    const result = classifyLlmError({ statusCode: 401, message: "Unauthorized" });
    expect(result.category).toBe("auth_invalid");
    expect(result.httpStatus).toBe(401);
    expect(result.userMessage).toContain("API Key");
  });

  it("403 → auth_forbidden", () => {
    const result = classifyLlmError({ statusCode: 403, message: "Forbidden" });
    expect(result.category).toBe("auth_forbidden");
    expect(result.httpStatus).toBe(403);
  });

  it("404 → model_not_found", () => {
    const result = classifyLlmError({ statusCode: 404, message: "Not Found" });
    expect(result.category).toBe("model_not_found");
  });

  it("429 → rate_limit", () => {
    const result = classifyLlmError({ statusCode: 429, message: "Too Many Requests" });
    expect(result.category).toBe("rate_limit");
    expect(result.httpStatus).toBe(429);
  });

  it("500 → server_error", () => {
    const result = classifyLlmError({ statusCode: 503, message: "Service Unavailable" });
    expect(result.category).toBe("server_error");
  });

  it("timeout 关键词 → timeout", () => {
    const result = classifyLlmError(new Error("Request timed out"));
    expect(result.category).toBe("timeout");
    expect(result.httpStatus).toBe(504);
  });

  it("ECONNREFUSED → network", () => {
    const result = classifyLlmError(new Error("connect ECONNREFUSED 127.0.0.1:3001"));
    expect(result.category).toBe("network");
  });

  it("CLI 子进程异常退出 → server_error 且可 fallback", () => {
    const result = classifyLlmError(new Error("CLI exited with code 1"));
    expect(result.category).toBe("server_error");
    expect(result.shouldFallback).toBe(true);
  });

  it("文本限流错误 → rate_limit 且可 fallback", () => {
    const result = classifyLlmError(new Error("provider quota exceeded"));
    expect(result.category).toBe("rate_limit");
    expect(result.shouldFallback).toBe(true);
  });

  it("文本鉴权错误 → auth_invalid 且可 fallback", () => {
    const result = classifyLlmError(new Error("authentication failed"));
    expect(result.category).toBe("auth_invalid");
    expect(result.shouldFallback).toBe(true);
  });

  it("Load failed → 外部链接不可读，且不自动 fallback 浪费 token", () => {
    const result = classifyLlmError(new Error("Load failed"));
    expect(result.category).toBe("web_content_unavailable");
    expect(result.userMessage).toContain("外部链接");
    expect(result.shouldFallback).toBe(false);
  });

  it("Claude CLI 401 凭据错误 → auth_invalid 且不自动 fallback", () => {
    const result = classifyLlmError(new Error("Failed to authenticate. API Error: 401 Invalid authentication credentials"));
    expect(result.category).toBe("auth_invalid");
    expect(result.shouldFallback).toBe(false);
  });

  it("未知错误 → unknown", () => {
    const result = classifyLlmError(new Error("some weird error"));
    expect(result.category).toBe("unknown");
    expect(result.httpStatus).toBe(500);
  });

  // 修复（2026-07-02，用户实测发现）：chat-fallback.ts 撞续跑/步数预算上限时抛的裸错误，
  // 之前落进 unknown 变成没有信息量的"对话失败，请稍后重试"，现在应该有专属分类和引导文案。
  it("续跑预算耗尽（chat-fallback.ts 裸错误）→ tool_budget_exhausted，不建议盲目重试", () => {
    const result = classifyLlmError(new Error("Model output was truncated after 2 automatic continuations"));
    expect(result.category).toBe("tool_budget_exhausted");
    expect(result.userMessage).toContain("拆成更小的步骤");
    expect(result.shouldFallback).toBe(false);
  });

  it("finishReason 异常结束（chat-fallback.ts 裸错误）→ tool_budget_exhausted", () => {
    const result = classifyLlmError(new Error("Model call ended abnormally: content-filter"));
    expect(result.category).toBe("tool_budget_exhausted");
    expect(result.shouldFallback).toBe(false);
  });
});

// ============ 1.2 修复：provider 专属规则匹配（国产 provider 中文错误体）============

describe("classifyLlmError - provider 专属规则（1.2）", () => {
  it("不传 providerType → 走 DEFAULT_ERROR_PATTERNS 通用英文兜底（向后兼容）", () => {
    const result = classifyLlmError(new Error("rate limit exceeded"));
    expect(result.category).toBe("rate_limit");
  });

  it("MiniMax 中文科率错误体 '余额不足' → rate_limit 且 shouldFallback=true", () => {
    const result = classifyLlmError(new Error("API 调用失败：余额不足"), undefined, "MiniMax");
    expect(result.category).toBe("rate_limit");
    expect(result.shouldFallback).toBe(true);
  });

  it("MiniMax '配额超限' → rate_limit", () => {
    const result = classifyLlmError(new Error("配额超限，请稍后重试"), undefined, "MiniMax");
    expect(result.category).toBe("rate_limit");
  });

  it("MiniMax '鉴权失败' → auth_invalid 且 shouldFallback=true", () => {
    const result = classifyLlmError(new Error("鉴权失败，请检查 API Key"), undefined, "MiniMax");
    expect(result.category).toBe("auth_invalid");
    expect(result.shouldFallback).toBe(true);
  });

  it("MiniMax 状态码 1305（自定义 code）→ rate_limit", () => {
    const result = classifyLlmError({ statusCode: 1305, message: "quota exceeded" }, undefined, "MiniMax");
    expect(result.category).toBe("rate_limit");
    expect(result.shouldFallback).toBe(true);
  });

  it("MiniMax '上下文过长' → context_overflow 且 shouldFallback=false（换模型救不了）", () => {
    const result = classifyLlmError(new Error("上下文过长，请缩短输入"), undefined, "MiniMax");
    expect(result.category).toBe("context_overflow");
    expect(result.shouldFallback).toBe(false);
  });

  it("MiniMax '模型不存在' → model_not_found 且 shouldFallback=true", () => {
    const result = classifyLlmError(new Error("模型不存在"), undefined, "MiniMax");
    expect(result.category).toBe("model_not_found");
    expect(result.shouldFallback).toBe(true);
  });

  it("deepseek 状态码 402（配额耗尽）→ rate_limit", () => {
    const result = classifyLlmError({ statusCode: 402, message: "Payment Required" }, undefined, "deepseek");
    expect(result.category).toBe("rate_limit");
    expect(result.shouldFallback).toBe(true);
  });

  it("deepseek '余额不足' → rate_limit", () => {
    const result = classifyLlmError(new Error("账户余额不足"), undefined, "deepseek");
    expect(result.category).toBe("rate_limit");
  });

  it("glm 状态码 1214（智谱限流）→ rate_limit", () => {
    const result = classifyLlmError({ statusCode: 1214, message: "rate limited" }, undefined, "glm");
    expect(result.category).toBe("rate_limit");
  });

  it("glm '鉴权失败' → auth_invalid", () => {
    const result = classifyLlmError(new Error("鉴权失败"), undefined, "glm");
    expect(result.category).toBe("auth_invalid");
    expect(result.shouldFallback).toBe(true);
  });

  it("kimi '额度不足' → rate_limit", () => {
    const result = classifyLlmError(new Error("您的额度不足"), undefined, "kimi");
    expect(result.category).toBe("rate_limit");
    expect(result.shouldFallback).toBe(true);
  });

  it("kimi '上下文过长' → context_overflow", () => {
    const result = classifyLlmError(new Error("上下文过长"), undefined, "kimi");
    expect(result.category).toBe("context_overflow");
    expect(result.shouldFallback).toBe(false);
  });

  it("未注册的 provider（如 'openai-compatible-某厂商'）→ 走 DEFAULT_ERROR_PATTERNS 通用兜底", () => {
    const result = classifyLlmError(new Error("rate limit exceeded"), undefined, "openai-compatible-某厂商");
    expect(result.category).toBe("rate_limit");
  });

  it("provider 专属关键词未命中时，落回通用英文兜底（rate_limit）", () => {
    // MiniMax 规则表里没有这个关键词，但 DEFAULT_ERROR_PATTERNS 有
    const result = classifyLlmError(new Error("rate_limit_exceeded"), undefined, "MiniMax");
    expect(result.category).toBe("rate_limit");
  });

  it("provider 专属匹配优先级：rate_limit 命中就不再查 auth_invalid", () => {
    // 错误体里同时含 rate_limit 和 authentication failed 关键词
    // rate_limit 优先级更高
    const result = classifyLlmError(new Error("rate limit exceeded, authentication failed"), undefined, "MiniMax");
    expect(result.category).toBe("rate_limit");
  });

  // ============ 1.2 实测真实响应体（2026-07-02 probe）============

  it("GLM 实测：超大 prompt 真实响应 → rate_limit（HTTP 429 + '该模型当前访问量过大'）", () => {
    // probe 实测：智谱对超大 prompt 不返 413 而是返 429（限流），fallback 可救
    const result = classifyLlmError(
      new Error("该模型当前访问量过大，请您稍后再试"),
      undefined,
      "glm",
    );
    expect(result.category).toBe("rate_limit");
    expect(result.shouldFallback).toBe(true);
  });

  it("GLM 实测：模型不存在真实响应 → model_not_found（HTTP 400 + body.code=1211）", () => {
    const result = classifyLlmError(
      new Error("模型不存在，请检查模型代码。"),
      undefined,
      "glm",
    );
    expect(result.category).toBe("model_not_found");
    expect(result.shouldFallback).toBe(true);
  });

  it("GLM 实测：错 key 真实响应 → auth_invalid（HTTP 401 + '令牌已过期或验证不正确'）", () => {
    const result = classifyLlmError(
      new Error("令牌已过期或验证不正确"),
      undefined,
      "glm",
    );
    expect(result.category).toBe("auth_invalid");
    expect(result.shouldFallback).toBe(true);
  });

  it("GLM 实测：错 key 走 HTTP 401 通用分支（不依赖关键词，因为有 statusCode）", () => {
    // 用户实际场景：错 key → HTTP 401 → 走通用 statusCode 检查 → auth_invalid
    const result = classifyLlmError(
      { statusCode: 401, message: "令牌已过期或验证不正确" },
      undefined,
      "glm",
    );
    expect(result.category).toBe("auth_invalid");
    expect(result.shouldFallback).toBe(true);
  });

  // ============ DeepSeek 实测（2026-07-02 probe）============

  it("DeepSeek 实测：错 key 真实响应 → auth_invalid（HTTP 401 + 'Authentication Fails'）", () => {
    const result = classifyLlmError(
      new Error("Authentication Fails, Your api key: ****RONG is invalid"),
      undefined,
      "deepseek",
    );
    expect(result.category).toBe("auth_invalid");
    expect(result.shouldFallback).toBe(true);
  });

  it("DeepSeek 实测：模型不存在真实响应 → model_not_found（HTTP 400 + 'model names are'）", () => {
    const result = classifyLlmError(
      new Error("The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed this-model-definitely-does-not-exist-12345."),
      undefined,
      "deepseek",
    );
    expect(result.category).toBe("model_not_found");
    expect(result.shouldFallback).toBe(true);
  });

  it("DeepSeek 实测：模型不存在用 HTTP 400（不是 404）→ model_not_found", () => {
    const result = classifyLlmError(
      { statusCode: 400, message: "The supported API model names are ..." },
      undefined,
      "deepseek",
    );
    expect(result.category).toBe("model_not_found");
  });

  // ============ MiniMax 实测（2026-07-02 probe）============

  it("MiniMax 实测：错 key 真实响应 → auth_invalid（HTTP 401 + 'login fail' + '(1004)'）", () => {
    const result = classifyLlmError(
      new Error("login fail: Please carry the API secret key in the 'Authorization' field of the request header (1004)"),
      undefined,
      "MiniMax",
    );
    expect(result.category).toBe("auth_invalid");
    expect(result.shouldFallback).toBe(true);
  });

  it("MiniMax 实测：错 key 走 HTTP 401 通用分支 → auth_invalid", () => {
    const result = classifyLlmError(
      { statusCode: 401, message: "login fail (1004)" },
      undefined,
      "MiniMax",
    );
    expect(result.category).toBe("auth_invalid");
    expect(result.shouldFallback).toBe(true);
  });

  it("MiniMax 实测：错误体里 'authorized_error' type → auth_invalid", () => {
    const result = classifyLlmError(
      new Error("authorized_error"),
      undefined,
      "MiniMax",
    );
    expect(result.category).toBe("auth_invalid");
  });
});

// ============ 1.4 修复：CLI 路径错误识别（spawnFailed / stalled）============

describe("classifyLlmError - CLI 路径错误（1.4）", () => {
  it("__cliKind=spawnFailed → cli_not_installed 且 shouldFallback=false（让用户先装 CLI）", () => {
    const spawnError = Object.assign(new Error("No such file or directory (os error 2)"), {
      __cliKind: "spawnFailed",
    });
    const result = classifyLlmError(spawnError);
    expect(result.category).toBe("cli_not_installed");
    expect(result.shouldFallback).toBe(false);
    expect(result.userMessage).toContain("Claude/Codex");
  });

  it("__cliKind=stalled → timeout 且 shouldFallback=true（可尝试 fallback）", () => {
    const stalledError = Object.assign(new Error("CLI 进程卡死未产生任何事件"), {
      __cliKind: "stalled",
    });
    const result = classifyLlmError(stalledError);
    expect(result.category).toBe("timeout");
    expect(result.shouldFallback).toBe(true);
  });

  it("__cliKind=executionFailed → 走通用 server_error 兜底（保持现有 fallback 行为）", () => {
    const execError = Object.assign(new Error("CLI exited with code 1"), {
      __cliKind: "executionFailed",
    });
    const result = classifyLlmError(execError);
    expect(result.category).toBe("server_error");
    expect(result.shouldFallback).toBe(true);
  });

  it("没 __cliKind → 走通用分类逻辑（向后兼容）", () => {
    const result = classifyLlmError(new Error("plain error"));
    expect(result.category).toBe("unknown");
  });
});

describe("asClassifiedError", () => {
  it("识别结构化 ClassifiedLlmError", () => {
    const err: ClassifiedLlmError = {
      category: "auth_invalid",
      httpStatus: 401,
      userMessage: "test",
      technicalMessage: "details",
      shouldFallback: true,
    };
    expect(asClassifiedError(err)).toBe(err);
  });

  it("非结构化错误返回 null", () => {
    expect(asClassifiedError(new Error("regular"))).toBeNull();
    expect(asClassifiedError(null)).toBeNull();
    expect(asClassifiedError("string")).toBeNull();
  });
});
