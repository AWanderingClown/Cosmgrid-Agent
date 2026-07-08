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
  it("注册默认只读工具，包含 LSP 查询能力", () => {
    const r = createDefaultToolRegistry();
    expect(r.has("read")).toBe(true);
    expect(r.has("glob")).toBe(true);
    expect(r.has("grep")).toBe(true);
    expect(r.has("git_read")).toBe(true);
    expect(r.has("web_fetch")).toBe(true);
    expect(r.has("web_search")).toBe(true);
    expect(r.has("todo_write")).toBe(true);
    expect(r.has("ask_user_question")).toBe(true);
    expect(r.has("lsp_diagnostics")).toBe(true);
    expect(r.has("lsp_definition")).toBe(true);
    expect(r.has("lsp_hover")).toBe(true);
    expect(r.listReadOnly()).toHaveLength(11);
  });
});

describe("buildAiSdkTools", () => {
  it("每个工具转成带 description 的 AI SDK tool", () => {
    const tools = buildAiSdkTools(createDefaultToolRegistry(), ctx);
    // remember（3.1 修复）始终注册，不分只读/写——它自己走 confirm 审批，不受权限档位过滤。
    expect(Object.keys(tools).sort()).toEqual([
      "ask_user_question",
      "git_read",
      "glob",
      "grep",
      "lsp_definition",
      "lsp_diagnostics",
      "lsp_hover",
      "read",
      "remember",
      "todo_write",
      "web_fetch",
      "web_search",
    ]);
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
