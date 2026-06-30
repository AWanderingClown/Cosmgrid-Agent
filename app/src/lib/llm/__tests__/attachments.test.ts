import { describe, it, expect } from "vitest";
import { classifyFile, ingestFile, toUserCoreMessage, type Attachment } from "../attachments";

describe("classifyFile", () => {
  it("图片按扩展名/type 识别", () => {
    expect(classifyFile({ name: "a.png", type: "image/png" })).toBe("image");
    expect(classifyFile({ name: "a.jpg", type: "" })).toBe("image");
    expect(classifyFile({ name: "a.JPEG", type: "" })).toBe("image"); // 大小写不敏感
    expect(classifyFile({ name: "a.webp", type: "" })).toBe("image");
    expect(classifyFile({ name: "a.gif", type: "" })).toBe("image");
  });

  it("文本文件按扩展名识别", () => {
    expect(classifyFile({ name: "a.ts", type: "" })).toBe("text-file");
    expect(classifyFile({ name: "a.tsx", type: "" })).toBe("text-file");
    expect(classifyFile({ name: "a.py", type: "" })).toBe("text-file");
    expect(classifyFile({ name: "a.md", type: "" })).toBe("text-file");
    expect(classifyFile({ name: "a.json", type: "" })).toBe("text-file");
  });

  it("按 MIME type 识别（无扩展名或未知扩展名）", () => {
    expect(classifyFile({ name: "a.unknown", type: "text/plain" })).toBe("text-file");
    expect(classifyFile({ name: "a.unknown", type: "image/png" })).toBe("image");
  });

  it("不支持的二进制/pdf/无扩展名", () => {
    expect(classifyFile({ name: "a.pdf", type: "application/pdf" })).toBe("unsupported");
    expect(classifyFile({ name: "a.zip", type: "application/zip" })).toBe("unsupported");
    expect(classifyFile({ name: "a.exe", type: "" })).toBe("unsupported");
    expect(classifyFile({ name: "README", type: "" })).toBe("unsupported"); // 无扩展名
  });
});

describe("toUserCoreMessage", () => {
  it("无附件 → 纯 string content（省 token）", () => {
    const m = toUserCoreMessage("你好", []);
    expect(m.role).toBe("user");
    expect(m.content).toBe("你好");
    expect(typeof m.content).toBe("string");
  });

  it("1 张图 → content 数组含 text + image part", () => {
    const img: Attachment = { id: "1", kind: "image", name: "a.png", mediaType: "image/png", dataUrl: "data:png" };
    const m = toUserCoreMessage("看图", [img]);
    expect(Array.isArray(m.content)).toBe(true);
    const parts = m.content as NonNullable<typeof m.content> extends Array<infer P> ? P[] : never;
    expect(parts[0]).toEqual({ type: "text", text: "看图" });
    expect(parts[1]).toEqual({ type: "image", image: "data:png", mediaType: "image/png" });
  });

  it("空 text + 1 图 → 只有 image part（不塞空 text）", () => {
    const img: Attachment = { id: "1", kind: "image", name: "a.png", mediaType: "image/png", dataUrl: "data:png" };
    const m = toUserCoreMessage("", [img]);
    expect(Array.isArray(m.content)).toBe(true);
    const parts = m.content as Array<{ type: string }>;
    expect(parts.length).toBe(1);
    expect(parts[0]!.type).toBe("image");
  });

  it("text-file 正文拼进 text（```文件名 块）", () => {
    const f: Attachment = { id: "1", kind: "text-file", name: "a.ts", mediaType: "text/plain", size: 10, text: "const x = 1;" };
    const m = toUserCoreMessage("改这个", [f]);
    expect(typeof m.content).toBe("string");
    expect(m.content).toContain("改这个");
    expect(m.content).toContain("```a.ts");
    expect(m.content).toContain("const x = 1;");
  });

  it("tooLarge text-file → 不拼正文，注入 tooLargeNotice", () => {
    const f: Attachment = { id: "1", kind: "text-file", name: "big.ts", mediaType: "text/plain", size: 30000, text: "", tooLarge: true };
    const m = toUserCoreMessage("看", [f], { tooLargeNotice: (n) => `[大文件:${n}]` });
    expect(typeof m.content).toBe("string");
    expect(m.content).toContain("[大文件:big.ts]");
    expect(m.content).not.toContain("```big.ts");
  });

  it("2 图 + 1 text-file 混合 → text part 含正文 + 2 个 image part", () => {
    const img1: Attachment = { id: "1", kind: "image", name: "a.png", mediaType: "image/png", dataUrl: "d1" };
    const img2: Attachment = { id: "2", kind: "image", name: "b.jpg", mediaType: "image/jpeg", dataUrl: "d2" };
    const f: Attachment = { id: "3", kind: "text-file", name: "c.ts", mediaType: "text/plain", size: 5, text: "code" };
    const m = toUserCoreMessage("混合", [img1, img2, f]);
    expect(Array.isArray(m.content)).toBe(true);
    const parts = m.content as Array<{ type: string; text?: string; image?: string }>;
    expect(parts[0]!.type).toBe("text");
    expect(parts[0]!.text).toContain("混合");
    expect(parts[0]!.text).toContain("```c.ts");
    expect(parts[1]).toMatchObject({ type: "image", image: "d1" });
    expect(parts[2]).toMatchObject({ type: "image", image: "d2" });
  });
});

describe("ingestFile 内容嗅探（不靠扩展名白名单）", () => {
  it("未知扩展名的文本文件（.properties）→ 当 text-file 收，正文读出来", async () => {
    const file = new File(["distributionUrl=https\\://services.gradle.org/x.zip\n"], "gradle-wrapper.properties", { type: "" });
    const r = await ingestFile(file);
    expect("kind" in r && r.kind).toBe("text-file");
    if ("kind" in r && r.kind === "text-file") {
      expect(r.text).toContain("distributionUrl");
    }
  });

  it("无扩展名的脚本（.command 内容是文本）→ text-file", async () => {
    const file = new File(["#!/bin/bash\necho hi\n"], "启动Boss投递.command", { type: "" });
    const r = await ingestFile(file);
    expect("kind" in r && r.kind).toBe("text-file");
  });

  it("无扩展名文件（Makefile）→ text-file", async () => {
    const file = new File(["build:\n\tgo build ./...\n"], "Makefile", { type: "" });
    const r = await ingestFile(file);
    expect("kind" in r && r.kind).toBe("text-file");
  });

  it("含 NUL 字节的二进制 → 仍判 unsupported", async () => {
    const bin = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]); // NUL 在内
    const file = new File([bin], "weird.dat", { type: "" });
    const r = await ingestFile(file);
    expect("error" in r && r.error).toBe("unsupported");
  });
});
