// view_image 工具单测（剩余问题汇总第 14 项，2026-07-09 新增）
//
// 用真文件系统（os.tmpdir）做集成：FsAdapter 默认走 Tauri plugin-fs，
// vitest 是 node 环境没 Tauri 运行时，所以这里用 setFsAdapter 注入一个
// 直接走 node:fs 的最小适配器，覆盖真实文件读取 + checkPath 路径校验 +
// mime 推断 + size 限制 + 多模态返回。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFsAdapter, type FsAdapter } from "../fs-adapter";
import { viewImageTool } from "../view-image-tool";
import { executeTool } from "../executor";
import type { ToolContext } from "../types";

// L6 安全网收拢（2026-07-09）：checkPath 现在由 executor 按 tool.security 声明统一跑，
// view-image-tool.ts 自己不再调用——测试改走 executeTool（跟生产路径一致）。
vi.mock("../../../db", () => ({
  toolExecutions: { create: vi.fn().mockResolvedValue("id") },
}));

const nodeFsAdapter: FsAdapter = {
  readTextFile: async () => "",
  readBytes: async (p) => {
    const { readFileSync } = await import("node:fs");
    return readFileSync(p);
  },
  readDir: async () => [],
  exists: async () => true,
  writeTextFile: async () => {},
  mkdirp: async () => {},
};

let workspacePath = "";
let tmpDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "view-image-test-"));
  workspacePath = tmpDir;
  setFsAdapter(nodeFsAdapter);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const ctx: ToolContext = { workspacePath };

// 1x1 透明 PNG（最小合法 PNG，67 字节）
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function writePng(name: string, size: number): string {
  const path = join(tmpDir, name);
  if (size <= PNG_BYTES.length) {
    writeFileSync(path, PNG_BYTES.subarray(0, size));
  } else {
    const padded = Buffer.concat([PNG_BYTES, Buffer.alloc(size - PNG_BYTES.length, 0)]);
    writeFileSync(path, padded);
  }
  return path;
}

describe("viewImageTool", () => {
  it("PNG 正常读取：返回 ImagePart 含正确 dataURL + mediaType", async () => {
    const path = writePng("ok.png", PNG_BYTES.length);
    const result = await executeTool(viewImageTool, { file_path: path }, ctx);

    expect(result.status).toBe("success");
    expect(result.parts).toHaveLength(2);
    expect(result.parts?.[0]).toMatchObject({ type: "text" });
    expect(result.parts?.[1]).toMatchObject({
      type: "image",
      mediaType: "image/png",
    });
    const image = result.parts?.[1] as { type: "image"; image: string; mediaType: string };
    expect(image.image.startsWith("data:image/png;base64,")).toBe(true);
    // 审计 output 是人类可读摘要，不含 base64
    expect(result.output).not.toContain("base64");
    expect(result.output).toContain("png");
  });

  it("路径越界拒绝（workspacePath 外）", async () => {
    const outside = "/etc/passwd.png";
    const result = await executeTool(viewImageTool, { file_path: outside }, ctx);
    expect(["denied", "error"]).toContain(result.status);
    expect(result.output).toMatch(/越出|路径|拒绝|不存在|ENOENT/);
    expect(result.parts).toBeUndefined();
  });

  it("敏感路径（.ssh）拒绝", async () => {
    // 让 readBytes 不会真去读
    setFsAdapter({
      ...nodeFsAdapter,
      readBytes: async () => {
        throw new Error("should not be called");
      },
    });
    const result = await executeTool(viewImageTool, { file_path: ".ssh/id_rsa.png" }, ctx);
    expect(result.status).toBe("denied");
  });

  it("超大图（>5MB）拒绝并提示压缩", async () => {
    const path = writePng("huge.png", 6 * 1024 * 1024);
    const result = await executeTool(viewImageTool, { file_path: path }, ctx);
    expect(result.status).toBe("error");
    expect(result.output).toContain("5MB");
    expect(result.output).toContain("压缩");
  });

  it("不支持的图片格式（.txt）拒绝", async () => {
    const path = join(tmpDir, "notes.txt");
    writeFileSync(path, "hello");
    const result = await executeTool(viewImageTool, { file_path: path }, ctx);
    expect(result.status).toBe("error");
    expect(result.output).toContain("不支持");
    expect(result.output).toContain("PNG/JPEG/WebP/GIF");
  });

  it("空文件拒绝", async () => {
    const path = join(tmpDir, "empty.png");
    writeFileSync(path, "");
    const result = await executeTool(viewImageTool, { file_path: path }, ctx);
    expect(result.status).toBe("error");
    expect(result.output).toContain("空");
  });

  it("JPEG / WebP / GIF 各自 mediaType 正确", async () => {
    setFsAdapter({
      ...nodeFsAdapter,
      readBytes: async () => Buffer.from("JPEG_DATA"),
    });
    const jpg = await executeTool(viewImageTool, { file_path: join(tmpDir, "a.jpg") }, ctx);
    expect((jpg.parts?.[1] as { mediaType: string }).mediaType).toBe("image/jpeg");

    const webp = await executeTool(viewImageTool, { file_path: join(tmpDir, "a.webp") }, ctx);
    expect((webp.parts?.[1] as { mediaType: string }).mediaType).toBe("image/webp");

    const gif = await executeTool(viewImageTool, { file_path: join(tmpDir, "a.gif") }, ctx);
    expect((gif.parts?.[1] as { mediaType: string }).mediaType).toBe("image/gif");
  });

  it("读取失败返回 status=error（FS 异常不抛给上层）", async () => {
    setFsAdapter({
      ...nodeFsAdapter,
      readBytes: async () => {
        throw new Error("EACCES");
      },
    });
    const result = await executeTool(viewImageTool, { file_path: join(tmpDir, "x.png") }, ctx);
    expect(result.status).toBe("error");
    expect(result.output).toContain("EACCES");
  });

  it("summary 字段含 mime + KB（不含 base64）", async () => {
    const path = writePng("small.png", PNG_BYTES.length);
    const result = await executeTool(viewImageTool, { file_path: path }, ctx);
    expect(result.output).toContain("png");
    expect(result.output).toContain("KB");
    expect(result.output.length).toBeLessThan(200);
  });
});