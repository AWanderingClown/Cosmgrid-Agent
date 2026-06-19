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

  it("未知错误 → unknown", () => {
    const result = classifyLlmError(new Error("some weird error"));
    expect(result.category).toBe("unknown");
    expect(result.httpStatus).toBe(500);
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
