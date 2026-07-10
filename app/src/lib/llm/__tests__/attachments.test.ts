import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 只 mock attachments.ts 自己用到的运行时依赖（Tauri plugin-fs / mammoth）。pdfjs 的
// worker URL 走 Vite 的 ?url 解析，未做 e2e mock，跳过对应分支。
vi.mock("@tauri-apps/plugin-fs", () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  readTextFile: vi.fn(),
  readDir: vi.fn(),
}));

vi.mock("mammoth", () => ({
  default: { extractRawText: vi.fn() },
  extractRawText: vi.fn(),
}));

import {
  classifyFile,
  ingestFile,
  parseAttachments,
  ingestPath,
  toUserCoreMessage,
  type Attachment,
} from "../attachments";

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

// ============================================================================
// 下面是为补 branches/行 覆盖新增的测试（不动原有 14 个 it）。
//
// 分支覆盖目标：parseAttachments / toUserCoreMessage(f folder / 默认 tooLarge
//  / 空 text) / classifyFile 边界 / ingestFile 的 image 路径 + FileReader mock
//  / text-file tooLarge / file.text throws / unsupported 嗅探分支 /
//  ingestDocumentBytes 通过 mammoth / ingestPath 的所有 Tauri 路径分支。
// ============================================================================

describe("parseAttachments 安全解析（坏数据 → 空数组，不抛错）", () => {
  it("undefined / null / 空字符串 → []", () => {
    expect(parseAttachments(undefined)).toEqual([]);
    expect(parseAttachments(null)).toEqual([]);
    expect(parseAttachments("")).toEqual([]);
  });

  it("非合法 JSON（解析抛错）→ []", () => {
    expect(parseAttachments("not-json{")).toEqual([]);
    expect(parseAttachments("{")).toEqual([]);
    expect(parseAttachments("[oops]")).toEqual([]);
  });

  it("合法 JSON 但非数组（字符串/对象/数字/null）→ []", () => {
    expect(parseAttachments('"hello"')).toEqual([]);
    expect(parseAttachments('{"a":1}')).toEqual([]);
    expect(parseAttachments("42")).toEqual([]);
    expect(parseAttachments("null")).toEqual([]);
    expect(parseAttachments("true")).toEqual([]);
  });

  it("合法 JSON 数组 → 原样返回（不做 deep clone，走同一引用语义反序列化）", () => {
    const arr: Attachment[] = [
      { id: "1", kind: "image", name: "a.png", mediaType: "image/png", dataUrl: "data:png;base64,XX" },
      { id: "2", kind: "text-file", name: "b.ts", mediaType: "text/plain", size: 3, text: "x" },
      { id: "3", kind: "folder", name: "proj", path: "/p" },
    ];
    const json = JSON.stringify(arr);
    const r = parseAttachments(json);
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ kind: "image", dataUrl: "data:png;base64,XX" });
    expect(r[1]).toMatchObject({ kind: "text-file", text: "x", size: 3 });
    expect(r[2]).toMatchObject({ kind: "folder", name: "proj", path: "/p" });
  });
});

describe("toUserCoreMessage — folder / 默认 tooLargeNotice / 空 text", () => {
  it("folder 附件 → text part 含『工作文件夹』+ 名称 + 路径", () => {
    const folder: Attachment = {
      id: "1",
      kind: "folder",
      name: "my-proj",
      path: "/Users/me/my-proj",
    };
    const m = toUserCoreMessage("读这个目录", [folder]);
    expect(typeof m.content).toBe("string");
    expect(m.content as string).toContain("读这个目录");
    expect(m.content as string).toContain("工作文件夹");
    expect(m.content as string).toContain("my-proj");
    expect(m.content as string).toContain("/Users/me/my-proj");
  });

  it("folder + image 混合 → content 是数组：text（含 folder 提示） + image part", () => {
    const folder: Attachment = { id: "1", kind: "folder", name: "proj", path: "/p" };
    const img: Attachment = {
      id: "2",
      kind: "image",
      name: "a.png",
      mediaType: "image/png",
      dataUrl: "d",
    };
    const m = toUserCoreMessage("看", [folder, img]);
    expect(Array.isArray(m.content)).toBe(true);
    const parts = m.content as Array<{ type: string; text?: string; image?: string }>;
    expect(parts[0]?.type).toBe("text");
    expect(parts[0]?.text).toContain("工作文件夹");
    expect(parts[0]?.text).toContain("proj");
    expect(parts[1]).toMatchObject({ type: "image", image: "d" });
  });

  it("只传 folder（无 text） → content 仍是 string（无图 → images.length === 0）", () => {
    const folder: Attachment = { id: "1", kind: "folder", name: "dir", path: "/d" };
    const m = toUserCoreMessage("", [folder]);
    expect(typeof m.content).toBe("string");
    expect(m.content as string).toContain("dir");
    expect(m.content as string).toContain("/d");
  });

  it("不传 opts.tooLargeNotice → 用默认英文提示覆盖 tooLarge text-file", () => {
    const f: Attachment = {
      id: "1",
      kind: "text-file",
      name: "big.ts",
      mediaType: "text/plain",
      size: 30000,
      text: "",
      tooLarge: true,
    };
    const m = toUserCoreMessage("看", [f]); // 故意不传 opts
    expect(m.content).toContain("big.ts");
    expect(m.content).toContain("too large");
    expect(m.content).toContain("workspace");
    expect(m.content).not.toContain("```big.ts");
  });

  it("text-file 非 tooLarge 但 text 为空 → 不追加 ``` 块（else 分支命中）", () => {
    const f: Attachment = {
      id: "1",
      kind: "text-file",
      name: "empty.ts",
      mediaType: "text/plain",
      size: 5,
      text: "",
    };
    const m = toUserCoreMessage("看", [f]);
    expect(typeof m.content).toBe("string");
    expect(m.content as string).not.toContain("```empty.ts");
  });
});

describe("classifyFile — MIME / 扩展名组合分支", () => {
  it("text/* MIME 命中的未知扩展名 → text-file（走 file.type.startsWith 分支）", () => {
    expect(classifyFile({ name: "a.unknown", type: "text/x-log" })).toBe("text-file");
  });

  it("image/* MIME 命中的未知扩展名 → image（走 file.type.startsWith 分支）", () => {
    expect(classifyFile({ name: "a.unknownext", type: "image/svg+xml" })).toBe("image");
  });

  it("image 扩展名的别名（.jpeg / .gif / .webp 大小写）→ image（走 IMAGE_EXTENSIONS.has 分支）", () => {
    expect(classifyFile({ name: "a.JPEG", type: "" })).toBe("image");
    expect(classifyFile({ name: "a.GIF", type: "" })).toBe("image");
    expect(classifyFile({ name: "a.WebP", type: "" })).toBe("image");
  });

  it("纯文本扩展名（没 type / 也没 startsWith）→ text-file", () => {
    expect(classifyFile({ name: "a.toml", type: "" })).toBe("text-file");
    expect(classifyFile({ name: "a.dockerfile", type: "" })).toBe("text-file");
  });

  it("都判不上 → unsupported（兜底 else）", () => {
    expect(classifyFile({ name: "abc", type: "" })).toBe("unsupported"); // 无扩展
    expect(classifyFile({ name: "weird.unknownext3", type: "application/octet-stream" })).toBe(
      "unsupported",
    );
  });
});

// ---------------------------------------------------------------------------
// FileReader 在 node 环境不存在，build 一个最小 mock：readAsDataURL 同步触发
// onload，result 给个固定 dataURL string。
// ---------------------------------------------------------------------------

class FakeFileReader {
  public result: string | ArrayBuffer | null = "data:image/png;base64,FAKEFAKE";
  public onload: (() => void) | null = null;
  public onerror: ((err: unknown) => void) | null = null;
  public error: unknown = null;
  readAsDataURL(_blob: Blob): void {
    // 同步派发 onload：readAsDataURL 的 Promise 立刻 resolve
    queueMicrotask(() => this.onload?.());
  }
}

describe("ingestFile — image 路径（mock FileReader）", () => {
  beforeEach(() => {
    vi.stubGlobal("FileReader", FakeFileReader as unknown as typeof FileReader);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("小图 → 返回 image 附件（含 dataUrl / mediaType / name / id）", async () => {
    const f = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "tiny.png", { type: "image/png" });
    const r = await ingestFile(f);
    expect("kind" in r && r.kind).toBe("image");
    if ("kind" in r && r.kind === "image") {
      expect(r.dataUrl).toContain("base64");
      expect(r.mediaType).toBe("image/png");
      expect(r.name).toBe("tiny.png");
      expect(typeof r.id).toBe("string");
      expect(r.id.length).toBeGreaterThan(0);
    }
  });

  it("图片 type 为空 → mediaType 兜底为 image/png", async () => {
    const f = new File([new Uint8Array([0, 1, 2])], "no-mime.png", { type: "" });
    const r = await ingestFile(f);
    expect("kind" in r && r.kind).toBe("image");
    if ("kind" in r && r.kind === "image") {
      expect(r.mediaType).toBe("image/png");
    }
  });

  it("图片 > 20MB → 直接拒 { error: 'image-too-large' }", async () => {
    // 20971521 = 20MB + 1
    const big = new Uint8Array(20 * 1024 * 1024 + 1);
    const f = new File([big], "huge.png", { type: "image/png" });
    const r = await ingestFile(f);
    expect("error" in r && r.error).toBe("image-too-large");
  });
});

describe("ingestFile — text-file 太长 / file.text() 抛错", () => {
  it("已知文本扩展名 + size > 200KB → tooLarge=true 且 text=''", async () => {
    const big = new Uint8Array(200 * 1024 + 100);
    const f = new File([big], "big.ts", { type: "text/plain" });
    const r = await ingestFile(f);
    expect("kind" in r && r.kind).toBe("text-file");
    if ("kind" in r && r.kind === "text-file") {
      expect(r.tooLarge).toBe(true);
      expect(r.text).toBe("");
      expect(r.size).toBe(big.length);
    }
  });

  it("已知文本扩展名 + size 小 + file.text 抛错 → text='' 不抛错（catch 分支）", async () => {
    // 用最小 fake File：text() 抛错，arrayBuffer 给一个空 buffer（不会被走到）
    const fakeFile = {
      name: "broken.ts",
      type: "text/plain",
      size: 5,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      text: () => Promise.reject(new Error("disk fail")),
    } as unknown as File;
    const r = await ingestFile(fakeFile);
    expect("kind" in r && r.kind).toBe("text-file");
    if ("kind" in r && r.kind === "text-file") {
      expect(r.text).toBe("");
      expect(r.tooLarge).toBeUndefined();
      expect(r.name).toBe("broken.ts");
    }
  });
});

describe("ingestFile — unsupported 嗅探分支", () => {
  it("未知扩展名 + size > 8MB（TEXT_SNIFF_MAX_BYTES）→ 不嗅探直接拒 unsupported", async () => {
    // 9 MB of zeros（不读字节）
    const huge = new Uint8Array(9 * 1024 * 1024);
    const f = new File([huge], "huge.unknownext9", { type: "" });
    const r = await ingestFile(f);
    expect("error" in r && r.error).toBe("unsupported");
  });

  it("未知扩展名 + 内容过大（> 200KB 但 ≤ 8MB） → 嗅探成功，tooLarge=true / text=''", async () => {
    // 300KB，全是 ASCII 'A'（不触发 NUL，looksLikeText 返回 true）
    const bytes = new Uint8Array(300 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = 65; // 'A'
    const f = new File([bytes], "bightxt", { type: "" });
    const r = await ingestFile(f);
    expect("kind" in r && r.kind).toBe("text-file");
    if ("kind" in r && r.kind === "text-file") {
      expect(r.tooLarge).toBe(true);
      expect(r.text).toBe("");
      expect(r.size).toBe(bytes.length);
      expect(r.mediaType).toBe("text/plain");
    }
  });

  it("未知扩展名 + 小 ASCII 内容 → 嗅探 → text-file，text 就是文件内容", async () => {
    const bytes = new TextEncoder().encode("hello world\n");
    const f = new File([bytes], "randomlog", { type: "" });
    const r = await ingestFile(f);
    expect("kind" in r && r.kind).toBe("text-file");
    if ("kind" in r && r.kind === "text-file") {
      expect(r.text).toBe("hello world\n");
      expect(r.tooLarge).toBeUndefined();
    }
  });
});

describe("ingestFile — docx 文本提取（mock mammoth）", () => {
  it("file.ext === '.docx' 且 mammoth 抽到文字 → 返回 text-file（含抽取文本）", async () => {
    // mammoth 模块对象同时有顶层 default 与具名 extractRawText
    const mammothMod = (await import("mammoth")) as unknown as {
      extractRawText: ReturnType<typeof vi.fn>;
      default: { extractRawText?: ReturnType<typeof vi.fn> };
    };
    mammothMod.extractRawText.mockResolvedValueOnce({ value: "doc body" });

    const f = new File([new Uint8Array([1, 2, 3])], "report.docx", { type: "" });
    const r = await ingestFile(f);
    expect("kind" in r && r.kind).toBe("text-file");
    if ("kind" in r && r.kind === "text-file") {
      expect(r.text).toBe("doc body");
      expect(r.tooLarge).toBeUndefined();
      expect(r.name).toBe("report.docx");
      expect(r.mediaType).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
    }
  });

  it("file.ext === '.docx' 且 mammoth 抽到的 text 为空 → 返回 { error: 'unsupported' }", async () => {
    const mammothMod = (await import("mammoth")) as unknown as {
      extractRawText: ReturnType<typeof vi.fn>;
    };
    mammothMod.extractRawText.mockResolvedValueOnce({ value: "" });

    const f = new File([new Uint8Array([1])], "empty.docx", { type: "" });
    const r = await ingestFile(f);
    expect("error" in r && r.error).toBe("unsupported");
  });

  it("file.ext === '.docx' 且 mammoth.extractRawText 抛错 → catch → 返回 { error: 'unsupported' }", async () => {
    const mammothMod = (await import("mammoth")) as unknown as {
      extractRawText: ReturnType<typeof vi.fn>;
    };
    mammothMod.extractRawText.mockRejectedValueOnce(new Error("mammoth boom"));

    const f = new File([new Uint8Array([1])], "broken.docx", { type: "" });
    const r = await ingestFile(f);
    expect("error" in r && r.error).toBe("unsupported");
  });
});

// ============================================================================
// ingestPath（Tauri 路径）：mock @tauri-apps/plugin-fs，覆盖每个分支。
// ============================================================================

import * as pluginFs from "@tauri-apps/plugin-fs";

const mstat = vi.mocked(pluginFs.stat);
const mreadFile = vi.mocked(pluginFs.readFile);
const mreadTextFile = vi.mocked(pluginFs.readTextFile);
const mreadDir = vi.mocked(pluginFs.readDir);

describe("ingestPath — 文件夹探测（stat 成功 + info.isDirectory）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stat 返回 isDirectory=true → { kind: 'folder' }", async () => {
    mstat.mockResolvedValueOnce({ isDirectory: true, isFile: false, size: 0 } as never);
    const r = await ingestPath("/Users/me/proj");
    expect("kind" in r && r.kind).toBe("folder");
    if ("kind" in r && r.kind === "folder") {
      expect(r.name).toBe("proj");
      expect(r.path).toBe("/Users/me/proj");
      expect(typeof r.id).toBe("string");
    }
    expect(mreadDir).not.toHaveBeenCalled();
  });

  it("Windows 路径分隔也能正确切到末段文件名", async () => {
    mstat.mockResolvedValueOnce({ isDirectory: true, isFile: false, size: 0 } as never);
    const r = await ingestPath("C:\\Users\\me\\proj");
    expect("kind" in r && r.kind).toBe("folder");
    if ("kind" in r && r.kind === "folder") {
      expect(r.name).toBe("proj");
      expect(r.path).toBe("C:\\Users\\me\\proj");
    }
  });
});

describe("ingestPath — stat 失败但 readDir 成功（文件夹探测 fallback）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stat 抛错 + readDir 成功 → { kind: 'folder' }（命中 catch 里的 readDir 分支）", async () => {
    mstat.mockRejectedValueOnce(new Error("not found"));
    mreadDir.mockResolvedValueOnce([{ name: "child.txt", isDirectory: false }] as never);
    const r = await ingestPath("/missing/but/is-dir");
    expect("kind" in r && r.kind).toBe("folder");
    if ("kind" in r && r.kind === "folder") {
      expect(r.path).toBe("/missing/but/is-dir");
    }
    expect(mreadDir).toHaveBeenCalledTimes(1);
  });

  it("stat 抛错 + readDir 也抛错 → { error: 'read-failed' }", async () => {
    mstat.mockRejectedValueOnce(new Error(""));
    mreadDir.mockRejectedValueOnce(new Error(""));
    const r = await ingestPath("/does/not/exist");
    expect("error" in r && r.error).toBe("read-failed");
  });
});

describe("ingestPath — 文件 stat 既不是文件夹也不是 file → unsupported", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("info.isFile=false 且 info.isDirectory=false → unsupported", async () => {
    mstat.mockResolvedValueOnce({ isDirectory: false, isFile: false, size: 0 } as never);
    const r = await ingestPath("/dev/some-special");
    expect("error" in r && r.error).toBe("unsupported");
  });
});

describe("ingestPath — 图片路径（mock bytesToDataUrl via FileReader）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("FileReader", FakeFileReader as unknown as typeof FileReader);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("图片 + size 正常 → image 附件，dataUrl / mediaType 推断正确（按扩展名）", async () => {
    mstat.mockResolvedValueOnce({ isDirectory: false, isFile: true, size: 100 } as never);
    mreadFile.mockResolvedValueOnce(new Uint8Array([1, 2, 3]) as never);
    const r = await ingestPath("/img/a.jpg");
    expect("kind" in r && r.kind).toBe("image");
    if ("kind" in r && r.kind === "image") {
      expect(r.mediaType).toBe("image/jpeg");
      expect(r.dataUrl).toContain("base64");
      expect(r.name).toBe("a.jpg");
    }
  });

  it("图片 > 20MB → { error: 'image-too-large' }", async () => {
    mstat.mockResolvedValueOnce({
      isDirectory: false,
      isFile: true,
      size: 20 * 1024 * 1024 + 1,
    } as never);
    // 源码是先 readFile 再看 bytes.byteLength，所以 mock 一个真超 20MB 的 Uint8Array
    mreadFile.mockResolvedValueOnce(new Uint8Array(20 * 1024 * 1024 + 1) as never);
    const r = await ingestPath("/img/huge.png");
    expect("error" in r && r.error).toBe("image-too-large");
    expect(mreadFile).toHaveBeenCalledTimes(1);
  });

  it("图片 readFile 抛错 → { error: 'read-failed' }（catch 分支）", async () => {
    mstat.mockResolvedValueOnce({ isDirectory: false, isFile: true, size: 10 } as never);
    mreadFile.mockRejectedValueOnce(new Error("disk fail"));
    const r = await ingestPath("/img/missing.png");
    expect("error" in r && r.error).toBe("read-failed");
  });
});

describe("ingestPath — 文本嗅探分支（unsupported 走嗅探）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("未知扩展名 + size > 8MB → 不读字节，直接拒 unsupported（TEXT_SNIFF_MAX_BYTES 分支）", async () => {
    mstat.mockResolvedValueOnce({
      isDirectory: false,
      isFile: true,
      size: 9 * 1024 * 1024,
    } as never);
    const r = await ingestPath("/logs/big.unknownext9");
    expect("error" in r && r.error).toBe("unsupported");
    expect(mreadFile).not.toHaveBeenCalled();
  });

  it("未知扩展名 + 小 ASCII → 嗅探成功 → text-file（text 拿到内容）", async () => {
    mstat.mockResolvedValueOnce({ isDirectory: false, isFile: true, size: 5 } as never);
    const bytes = new TextEncoder().encode("log line");
    mreadFile.mockResolvedValueOnce(bytes as never);
    const r = await ingestPath("/logs/randomlog");
    expect("kind" in r && r.kind).toBe("text-file");
    if ("kind" in r && r.kind === "text-file") {
      expect(r.text).toBe("log line");
      expect(r.mediaType).toBe("text/plain");
    }
  });

  it("未知扩展名 + 大 ASCII → 嗅探 → tooLarge=true / text=''", async () => {
    mstat.mockResolvedValueOnce({
      isDirectory: false,
      isFile: true,
      size: 300 * 1024, // size 本身就是 300KB，超过 TEXT_FILE_MAX_BYTES
    } as never);
    const bytes = new Uint8Array(300 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = 65;
    mreadFile.mockResolvedValueOnce(bytes as never);
    const r = await ingestPath("/logs/bightxt");
    expect("kind" in r && r.kind).toBe("text-file");
    if ("kind" in r && r.kind === "text-file") {
      expect(r.tooLarge).toBe(true);
      expect(r.text).toBe("");
    }
  });

  it("未知扩展名 + 含 NUL → { error: 'unsupported' }（looksLikeText false 分支）", async () => {
    mstat.mockResolvedValueOnce({ isDirectory: false, isFile: true, size: 5 } as never);
    const bytes = new Uint8Array([0x50, 0x00, 0x01, 0x02]); // 含 NUL
    mreadFile.mockResolvedValueOnce(bytes as never);
    const r = await ingestPath("/weird.unknownext9");
    expect("error" in r && r.error).toBe("unsupported");
  });

  it("未知扩展名 + readFile 抛错 → { error: 'read-failed' }", async () => {
    mstat.mockResolvedValueOnce({ isDirectory: false, isFile: true, size: 5 } as never);
    mreadFile.mockRejectedValueOnce(new Error("boom"));
    const r = await ingestPath("/weird.unknownext9");
    expect("error" in r && r.error).toBe("read-failed");
  });
});

describe("ingestPath — 已知文本扩展名（不用嗅探）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("info.size 缺失 → 兜底 size=0 → text-file，text 来自 readTextFile", async () => {
    mstat.mockResolvedValueOnce({ isDirectory: false, isFile: true } as never);
    mreadTextFile.mockResolvedValueOnce("console.log('hi')" as never);
    const r = await ingestPath("/code/a.ts");
    expect("kind" in r && r.kind).toBe("text-file");
    if ("kind" in r && r.kind === "text-file") {
      expect(r.text).toBe("console.log('hi')");
      expect(r.size).toBe(0);
      expect(r.tooLarge).toBeUndefined();
    }
  });

  it("size > 200KB → 直接 tooLarge=true，不调 readTextFile", async () => {
    mstat.mockResolvedValueOnce({
      isDirectory: false,
      isFile: true,
      size: 300 * 1024,
    } as never);
    const r = await ingestPath("/code/big.ts");
    expect("kind" in r && r.kind).toBe("text-file");
    if ("kind" in r && r.kind === "text-file") {
      expect(r.tooLarge).toBe(true);
      expect(r.text).toBe("");
    }
    expect(mreadTextFile).not.toHaveBeenCalled();
  });

  it("readTextFile 抛错 → catch → text=''", async () => {
    mstat.mockResolvedValueOnce({ isDirectory: false, isFile: true, size: 10 } as never);
    mreadTextFile.mockRejectedValueOnce(new Error("boom"));
    const r = await ingestPath("/code/broken.ts");
    expect("kind" in r && r.kind).toBe("text-file");
    if ("kind" in r && r.kind === "text-file") {
      expect(r.text).toBe("");
      expect(r.tooLarge).toBeUndefined();
    }
  });
});

describe("ingestPath — PDF 路径（readFile → ingestDocumentBytes, mammoth fallback 抛走的是 mammoth）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(".pdf 文件走 readFile 后到 PDF 提取（pdfjs worker 加载失败 → catch → unsupported）", async () => {
    mstat.mockResolvedValueOnce({ isDirectory: false, isFile: true, size: 9 } as never);
    mreadFile.mockResolvedValueOnce(new Uint8Array([0x25, 0x50, 0x44, 0x46]) as never);
    // 不 mock pdfjs：动态 import 进入会失败 → extractPdfText 抛错 → catch 命中 → unsupported
    const r = await ingestPath("/a.pdf");
    expect("error" in r && r.error).toBe("unsupported");
  });

  it(".pdf 文件 readFile 抛错 → { error: 'read-failed' }（PDF readFile catch 分支）", async () => {
    mstat.mockResolvedValueOnce({ isDirectory: false, isFile: true, size: 9 } as never);
    mreadFile.mockRejectedValueOnce(new Error("fs fail"));
    const r = await ingestPath("/x.pdf");
    expect("error" in r && r.error).toBe("read-failed");
  });

  it(".docx 文件走 readFile + mammoth 成功 → text-file（含抽取文本）", async () => {
    mstat.mockResolvedValueOnce({ isDirectory: false, isFile: true, size: 9 } as never);
    mreadFile.mockResolvedValueOnce(new Uint8Array([1, 2, 3]) as never);
    const mammothMod = (await import("mammoth")) as unknown as {
      extractRawText: ReturnType<typeof vi.fn>;
    };
    mammothMod.extractRawText.mockResolvedValueOnce({ value: "docx body" });
    const r = await ingestPath("/a.docx");
    expect("kind" in r && r.kind).toBe("text-file");
    if ("kind" in r && r.kind === "text-file") {
      expect(r.text).toBe("docx body");
      expect(r.mediaType).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
    }
  });

  it(".docx 文件 readFile 抛错 → { error: 'read-failed' }", async () => {
    mstat.mockResolvedValueOnce({ isDirectory: false, isFile: true, size: 9 } as never);
    mreadFile.mockRejectedValueOnce(new Error("fs fail"));
    const r = await ingestPath("/x.docx");
    expect("error" in r && r.error).toBe("read-failed");
  });
});
