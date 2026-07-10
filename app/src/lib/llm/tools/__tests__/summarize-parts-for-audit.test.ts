import { describe, expect, it } from "vitest";
import { summarizePartsForAudit } from "../executor";
import type { ContentPart } from "../types";

describe("summarizePartsForAudit", () => {
  it("空数组返回空字符串", () => {
    expect(summarizePartsForAudit([])).toBe("");
  });

  it("单 text part 只输出文本字节数前缀 + 文本本身", () => {
    const parts: ContentPart[] = [{ type: "text", text: "1920×1080 PNG 2.1MB" }];
    // × 是 UTF-8 多字节字符，整个文本 19B（不是 18 字符）
    expect(summarizePartsForAudit(parts)).toBe("[text 19B] | 1920×1080 PNG 2.1MB");
  });

  it("image part 输出 mime + KB 摘要（不存 base64）", () => {
    const b64 = "A".repeat(1400);
    const parts: ContentPart[] = [
      { type: "image", image: `data:image/png;base64,${b64}`, mediaType: "image/png" },
    ];
    const out = summarizePartsForAudit(parts);
    expect(out).toContain("[image png");
    expect(out).toContain("KB]");
    expect(out).not.toContain(b64);
    expect(out.length).toBeLessThan(80);
  });

  it("混合 text + image 两类都出现且不存 base64", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "hello" },
      { type: "image", image: "data:image/jpeg;base64,ZZZZ", mediaType: "image/jpeg" },
      { type: "text", text: "world" },
    ];
    const out = summarizePartsForAudit(parts);
    expect(out).toContain("[text 10B]");
    expect(out).toContain("[image jpeg");
    expect(out).toContain("hello");
    expect(out).toContain("world");
    expect(out).not.toContain("ZZZZ");
    expect(out).toContain(" | ");
  });

  it("KB 计算正确（1400 base64 字符 ≈ 1050 bytes ≈ 1.0KB）", () => {
    const parts: ContentPart[] = [
      { type: "image", image: `data:image/png;base64,${"A".repeat(1400)}`, mediaType: "image/png" },
    ];
    expect(summarizePartsForAudit(parts)).toContain("1.0KB");
  });
});