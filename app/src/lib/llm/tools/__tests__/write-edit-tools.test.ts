// write/edit/diff 工具单测（v0.7 阶段4b：写操作 + 确认门）
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setFsAdapter, type FsAdapter } from "../fs-adapter";
import { writeTool } from "../write-tool";
import { editTool } from "../edit-tool";
import { computeDiff } from "../diff-util";
import type { ToolContext } from "../types";

const WS = "/ws";

// 可变内存 fs（写会更新 map）
function makeMutableFs(initial: Record<string, string>): { fs: FsAdapter; files: Record<string, string> } {
  const files = { ...initial };
  const fs: FsAdapter = {
    readTextFile: async (p) => {
      if (p in files) return files[p]!;
      throw new Error(`ENOENT: ${p}`);
    },
    readDir: async () => [],
    exists: async (p) => p in files,
    writeTextFile: async (p, c) => { files[p] = c; },
    mkdirp: async () => {},
  };
  return { fs, files };
}

let files: Record<string, string>;
function ctxWith(confirm?: ToolContext["confirm"]): ToolContext {
  return { workspacePath: WS, ...(confirm ? { confirm } : {}) };
}

beforeEach(() => {
  const m = makeMutableFs({ "/ws/src/a.ts": "const x = 1;\nconst y = 2;\n" });
  files = m.files;
  setFsAdapter(m.fs);
});

describe("computeDiff", () => {
  it("统计增删行", () => {
    const d = computeDiff("a\nb\n", "a\nc\nd\n");
    expect(d.added).toBeGreaterThan(0);
    expect(d.removed).toBeGreaterThan(0);
    expect(d.patch).toContain("+c");
    expect(d.patch).toContain("-b");
  });
  it("无变化时增删为 0", () => {
    const d = computeDiff("same\n", "same\n");
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
  });
});

describe("write 工具", () => {
  it("用户确认后写入新文件", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await writeTool.execute({ file_path: "src/new.ts", content: "hello" }, ctxWith(confirm));
    expect(r.status).toBe("success");
    expect(files["/ws/src/new.ts"]).toBe("hello");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("没有 confirm 通道 → denied，不写盘", async () => {
    const r = await writeTool.execute({ file_path: "src/new.ts", content: "x" }, ctxWith());
    expect(r.status).toBe("denied");
    expect(files["/ws/src/new.ts"]).toBeUndefined();
  });

  it("用户拒绝 → denied，不写盘", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const r = await writeTool.execute({ file_path: "src/new.ts", content: "x" }, ctxWith(confirm));
    expect(r.status).toBe("denied");
    expect(files["/ws/src/new.ts"]).toBeUndefined();
  });

  it("越界路径直接拒绝，不弹确认", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await writeTool.execute({ file_path: "../../etc/x", content: "x" }, ctxWith(confirm));
    expect(r.status).toBe("denied");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("敏感路径直接拒绝", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await writeTool.execute({ file_path: ".env", content: "SECRET=1" }, ctxWith(confirm));
    expect(r.status).toBe("denied");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("覆盖已有文件时 diff 体现旧内容", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    await writeTool.execute({ file_path: "src/a.ts", content: "const x = 99;\n" }, ctxWith(confirm));
    const arg = confirm.mock.calls[0]![0];
    expect(arg.diff).toContain("const x = 1;");
    expect(arg.diff).toContain("+const x = 99;");
  });
});

describe("edit 工具", () => {
  it("唯一匹配 + 确认 → 替换成功", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await editTool.execute(
      { file_path: "src/a.ts", old_string: "const x = 1;", new_string: "const x = 42;" },
      ctxWith(confirm),
    );
    expect(r.status).toBe("success");
    expect(files["/ws/src/a.ts"]).toContain("const x = 42;");
  });

  it("old_string 找不到 → error", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await editTool.execute(
      { file_path: "src/a.ts", old_string: "不存在的内容", new_string: "x" },
      ctxWith(confirm),
    );
    expect(r.status).toBe("error");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("old_string 出现多次 → error（需唯一）", async () => {
    const m = makeMutableFs({ "/ws/dup.ts": "foo\nfoo\n" });
    files = m.files;
    setFsAdapter(m.fs);
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await editTool.execute(
      { file_path: "dup.ts", old_string: "foo", new_string: "bar" },
      ctxWith(confirm),
    );
    expect(r.status).toBe("error");
    expect(r.output).toMatch(/2 次/);
  });

  it("old==new → error", async () => {
    const r = await editTool.execute(
      { file_path: "src/a.ts", old_string: "x", new_string: "x" },
      ctxWith(vi.fn().mockResolvedValue(true)),
    );
    expect(r.status).toBe("error");
  });

  it("用户拒绝 → 不写盘", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const before = files["/ws/src/a.ts"];
    const r = await editTool.execute(
      { file_path: "src/a.ts", old_string: "const x = 1;", new_string: "const x = 0;" },
      ctxWith(confirm),
    );
    expect(r.status).toBe("denied");
    expect(files["/ws/src/a.ts"]).toBe(before);
  });
});
