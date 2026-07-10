import { describe, expect, it } from "vitest";
import type { ContentPart, ToolResult } from "../types";

describe("ToolResult.parts", () => {
  it("缺省时仍走纯 output 字符串形态（向后兼容）", () => {
    const result: ToolResult = { status: "success", output: "hello world" };
    expect(result.parts).toBeUndefined();
    expect(result.output).toBe("hello world");
  });

  it("存在 parts 时 output 仍可作为降级文本（人类/审计用）", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "1920×1080 PNG 2.1MB" },
      { type: "image", image: "data:image/png;base64,AAA", mediaType: "image/png" },
    ];
    const result: ToolResult = {
      status: "success",
      output: "图片 1920×1080 PNG 2.1MB",
      parts,
    };
    expect(result.parts).toHaveLength(2);
    expect(result.parts?.[0]).toEqual({ type: "text", text: "1920×1080 PNG 2.1MB" });
    expect(result.parts?.[1]).toMatchObject({ type: "image", mediaType: "image/png" });
    expect((result.parts?.[1] as { image: string }).image.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("denied/timeout/error 状态仍只需 output，不需要 parts", () => {
    const denied: ToolResult = { status: "denied", output: "用户拒绝" };
    const timeout: ToolResult = { status: "timeout", output: "执行超时" };
    const error: ToolResult = { status: "error", output: "路径不存在" };
    expect(denied.parts).toBeUndefined();
    expect(timeout.parts).toBeUndefined();
    expect(error.parts).toBeUndefined();
  });

  it("TextPart / ImagePart / ContentPart 判别字段是 type", () => {
    const text: ContentPart = { type: "text", text: "hi" };
    const image: ContentPart = { type: "image", image: "data:image/png;base64,X", mediaType: "image/png" };
    expect(text.type).toBe("text");
    expect(image.type).toBe("image");
  });
});