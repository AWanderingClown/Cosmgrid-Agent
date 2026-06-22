// tools/index 单测（v0.7 阶段4：默认注册表 + AI SDK 转换）
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../../db", () => ({
  toolExecutions: { create: vi.fn().mockResolvedValue("id") },
}));

import { createDefaultToolRegistry, buildAiSdkTools } from "../index";
import { setFsAdapter, type FsAdapter } from "../fs-adapter";
import type { ToolContext } from "../types";

const ctx: ToolContext = { workspacePath: "/ws" };

beforeEach(() => {
  const fs: FsAdapter = {
    readTextFile: async () => "hello\nworld",
    readDir: async () => [],
    exists: async () => true,
    writeTextFile: async () => {},
    mkdirp: async () => {},
  };
  setFsAdapter(fs);
});

describe("createDefaultToolRegistry", () => {
  it("注册 read/glob/grep/git_read 四个只读工具", () => {
    const r = createDefaultToolRegistry();
    expect(r.has("read")).toBe(true);
    expect(r.has("glob")).toBe(true);
    expect(r.has("grep")).toBe(true);
    expect(r.has("git_read")).toBe(true);
    expect(r.listReadOnly()).toHaveLength(4);
  });
});

describe("buildAiSdkTools", () => {
  it("每个工具转成带 description 的 AI SDK tool", () => {
    const tools = buildAiSdkTools(createDefaultToolRegistry(), ctx);
    expect(Object.keys(tools).sort()).toEqual(["git_read", "glob", "grep", "read"]);
    expect(tools.read!.description).toContain("读取");
    expect(tools.git_read!.description).toContain("git");
  });

  it("tool.execute 走 executeTool 返回字符串输出", async () => {
    const tools = buildAiSdkTools(createDefaultToolRegistry(), ctx);
    const out = await (tools.read!.execute as any)({ file_path: "a.ts" }, {});
    expect(typeof out).toBe("string");
    expect(out).toContain("hello");
  });
});
