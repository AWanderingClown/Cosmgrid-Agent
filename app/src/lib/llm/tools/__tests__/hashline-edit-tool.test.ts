// hashline_edit 工具单测（2026-07-10 移植 OMO hashline）——只覆盖核心行为，
// 不重复造 hashline-core 内部纯函数的测试（那些用例在 OMO 上游已经跑过）。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setFsAdapter, type FsAdapter } from "../fs-adapter";
import { setGitSnapshot } from "../git-snapshot";
import { setShellAdapter, type ShellAdapter } from "../shell-adapter";
import { hashlineEditTool } from "../hashline-edit-tool";
import { executeTool } from "../executor";
import { formatHashLine } from "../hashline";
import type { ToolContext } from "../types";

vi.mock("../../../db", () => ({
  toolExecutions: { create: vi.fn().mockResolvedValue("id") },
}));

const WS = "/ws";

function makeMutableFs(initial: Record<string, string>): { fs: FsAdapter; files: Record<string, string> } {
  const files = { ...initial };
  const fs: FsAdapter = {
    readTextFile: async (p) => {
      if (p in files) return files[p]!;
      throw new Error(`ENOENT: ${p}`);
    },
    readBytes: async () => new Uint8Array(0),
    readDir: async () => [],
    exists: async (p) => p in files,
    writeTextFile: async (p, c) => {
      files[p] = c;
    },
    mkdirp: async () => {},
  };
  return { fs, files };
}

let files: Record<string, string>;
function ctxWith(confirm?: ToolContext["confirm"]): ToolContext {
  return { workspacePath: WS, ...(confirm ? { confirm } : {}) };
}

beforeEach(() => {
  const m = makeMutableFs({ "/ws/src/a.ts": "const x = 1;\nconst y = 2;\nconst z = 3;\n" });
  files = m.files;
  setFsAdapter(m.fs);
  setGitSnapshot({ commitFile: async () => true, initShadowRepo: async () => {} });
  setShellAdapter({
    run: async () => ({ stdout: "", stderr: "", code: 0 }),
    runArgs: async () => ({ stdout: "", stderr: "", code: 0 }),
  } as ShellAdapter);
});

describe("hashline_edit 工具", () => {
  it("按 pos 引用 replace 单行", async () => {
    const ref = `1#${formatHashLine(1, "const x = 1;").split("#")[1]!.split("|")[0]}`;
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(
      hashlineEditTool,
      { file_path: "src/a.ts", edits: [{ op: "replace", pos: ref, lines: "const x = 42;" }] },
      ctxWith(confirm),
    );
    expect(r.status).toBe("success");
    expect(files["/ws/src/a.ts"]).toContain("const x = 42;");
    expect(files["/ws/src/a.ts"]).toContain("const y = 2;");
  });

  it("按 pos~end 引用 replace 多行范围", async () => {
    const line1 = formatHashLine(1, "const x = 1;");
    const line2 = formatHashLine(2, "const y = 2;");
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(
      hashlineEditTool,
      {
        file_path: "src/a.ts",
        edits: [{ op: "replace", pos: line1.split("|")[0], end: line2.split("|")[0], lines: ["const x = 10;", "const y = 20;"] }],
      },
      ctxWith(confirm),
    );
    expect(r.status).toBe("success");
    expect(files["/ws/src/a.ts"]).toContain("const x = 10;\nconst y = 20;");
  });

  it("append 在锚点行之后插入", async () => {
    const line1 = formatHashLine(1, "const x = 1;");
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(
      hashlineEditTool,
      { file_path: "src/a.ts", edits: [{ op: "append", pos: line1.split("|")[0], lines: "const inserted = true;" }] },
      ctxWith(confirm),
    );
    expect(r.status).toBe("success");
    expect(files["/ws/src/a.ts"]).toBe("const x = 1;\nconst inserted = true;\nconst y = 2;\nconst z = 3;\n");
  });

  it("prepend 在锚点行之前插入", async () => {
    const line2 = formatHashLine(2, "const y = 2;");
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(
      hashlineEditTool,
      { file_path: "src/a.ts", edits: [{ op: "prepend", pos: line2.split("|")[0], lines: "const before = true;" }] },
      ctxWith(confirm),
    );
    expect(r.status).toBe("success");
    expect(files["/ws/src/a.ts"]).toBe("const x = 1;\nconst before = true;\nconst y = 2;\nconst z = 3;\n");
  });

  it("hash 失配（文件已被改动）→ error，报文带最新引用提示", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(
      hashlineEditTool,
      { file_path: "src/a.ts", edits: [{ op: "replace", pos: "1#ZZ", lines: "const x = 99;" }] },
      ctxWith(confirm),
    );
    expect(r.status).toBe("error");
    expect(r.output).toMatch(/changed since last read/);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("用户拒绝确认 → denied，不写盘", async () => {
    const line1 = formatHashLine(1, "const x = 1;");
    const confirm = vi.fn().mockResolvedValue(false);
    const before = files["/ws/src/a.ts"];
    const r = await executeTool(
      hashlineEditTool,
      { file_path: "src/a.ts", edits: [{ op: "replace", pos: line1.split("|")[0], lines: "const x = 0;" }] },
      ctxWith(confirm),
    );
    expect(r.status).toBe("denied");
    expect(files["/ws/src/a.ts"]).toBe(before);
  });

  it("全部编辑都是空操作（内容与原文一致）→ error", async () => {
    const line1 = formatHashLine(1, "const x = 1;");
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(
      hashlineEditTool,
      { file_path: "src/a.ts", edits: [{ op: "replace", pos: line1.split("|")[0], lines: "const x = 1;" }] },
      ctxWith(confirm),
    );
    expect(r.status).toBe("error");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("工作区外的文件也能改——摘要标出'工作区之外'，批准后正常写入", async () => {
    const m = makeMutableFs({ "/Users/me/Desktop/plan.md": "old line\n" });
    files = m.files;
    setFsAdapter(m.fs);
    const ref = formatHashLine(1, "old line").split("|")[0];
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(
      hashlineEditTool,
      { file_path: "/Users/me/Desktop/plan.md", edits: [{ op: "replace", pos: ref, lines: "new line" }] },
      ctxWith(confirm),
    );
    expect(r.status).toBe("success");
    expect(files["/Users/me/Desktop/plan.md"]).toBe("new line\n");
    const arg = confirm.mock.calls[0]![0];
    expect(arg.summary).toContain("工作区之外");
  });
});
