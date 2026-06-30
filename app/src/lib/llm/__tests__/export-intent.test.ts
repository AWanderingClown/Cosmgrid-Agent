import { describe, expect, it } from "vitest";
import { buildMarkdownExportContent, detectDesktopExportIntent, sanitizeExportFileName } from "../export-intent";

describe("detectDesktopExportIntent", () => {
  it("detects explicit desktop export requests", () => {
    expect(detectDesktopExportIntent("把这份方案保存到桌面")).toEqual({ target: "desktop" });
    expect(detectDesktopExportIntent("export this plan to Desktop")).toEqual({ target: "desktop" });
  });

  it("ignores non-export chat", () => {
    expect(detectDesktopExportIntent("这份方案怎么样")).toBeNull();
    expect(detectDesktopExportIntent("保存一下重点")).toBeNull();
  });
});

describe("sanitizeExportFileName", () => {
  it("removes path separators and unsafe characters", () => {
    expect(sanitizeExportFileName("a/b:c*?")).toBe("a-b-c");
  });
});

describe("buildMarkdownExportContent", () => {
  it("wraps the previous assistant content as markdown", () => {
    const out = buildMarkdownExportContent({
      title: "方案",
      userRequest: "保存到桌面",
      content: "正文",
      createdAt: new Date("2026-06-30T00:00:00.000Z"),
    });
    expect(out).toContain("# 方案");
    expect(out).toContain("> 保存到桌面");
    expect(out).toContain("正文");
  });
});
