// 工具参数错误自纠单测（2026-07-10 移植 OMO delegate-core/retry-patterns 思路）。
import { describe, it, expect, vi } from "vitest";
import { setFsAdapter, type FsAdapter } from "../fs-adapter";
import { hashlineEditTool } from "../hashline-edit-tool";
import { executeTool } from "../executor";
import type { ToolContext } from "../types";

vi.mock("../../../db", () => ({
  toolExecutions: { create: vi.fn().mockResolvedValue("id") },
}));

const WS = "/ws";
const ctx: ToolContext = { workspacePath: WS };

function makeFakeFs(): FsAdapter {
  return {
    readTextFile: async () => "line1\n",
    readBytes: async () => new Uint8Array(0),
    readDir: async () => [],
    exists: async () => true,
    writeTextFile: async () => {},
    mkdirp: async () => {},
  };
}

describe("工具参数错误自纠", () => {
  it("缺必填字段 → 给出可读的逐字段修复提示，而不是原始 ZodError JSON", async () => {
    setFsAdapter(makeFakeFs());
    const r = await executeTool(hashlineEditTool, { edits: [{ op: "replace", pos: "1#ZZ", lines: "x" }] }, ctx);
    expect(r.status).toBe("error");
    expect(r.output).toContain('工具 "hashline_edit" 的参数不对');
    expect(r.output).toContain('字段 "file_path"');
    expect(r.output).not.toContain('"code"'); // 不应该是原始 ZodError JSON
  });

  it("空数组（未满足最小长度）→ 提示至少需要几个元素", async () => {
    setFsAdapter(makeFakeFs());
    const r = await executeTool(hashlineEditTool, { file_path: "a.ts", edits: [] }, ctx);
    expect(r.status).toBe("error");
    expect(r.output).toContain('字段 "edits"');
    expect(r.output).toMatch(/至少需要/);
  });

  it("枚举值不合法 → 列出允许的取值", async () => {
    setFsAdapter(makeFakeFs());
    const r = await executeTool(
      hashlineEditTool,
      { file_path: "a.ts", edits: [{ op: "bogus", pos: "1#ZZ", lines: "x" }] },
      ctx,
    );
    expect(r.status).toBe("error");
    expect(r.output).toContain("replace");
    expect(r.output).toContain("append");
    expect(r.output).toContain("prepend");
  });
});
