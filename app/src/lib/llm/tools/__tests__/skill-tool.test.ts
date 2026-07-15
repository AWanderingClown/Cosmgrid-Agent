import { describe, it, expect } from "vitest";
import { skillTool } from "../skill-tool";
import { setFsAdapter, type FsAdapter } from "../fs-adapter";
import type { ToolContext } from "../types";

function makeFakeFs(files: Record<string, string>): FsAdapter {
  const paths = Object.keys(files);
  return {
    readTextFile: async (p) => {
      if (p in files) return files[p]!;
      throw new Error(`ENOENT: ${p}`);
    },
    readBytes: async () => new Uint8Array(0),
    exists: async (p) => paths.some((f) => f === p || f.startsWith(p + "/")),
    readDir: async (dir) => {
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      const names = new Map<string, { name: string; isDirectory: boolean; isFile: boolean }>();
      for (const f of paths) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          names.set(rest, { name: rest, isDirectory: false, isFile: true });
        } else {
          const dirName = rest.slice(0, slash);
          if (!names.has(dirName)) names.set(dirName, { name: dirName, isDirectory: true, isFile: false });
        }
      }
      return Array.from(names.values());
    },
    writeTextFile: async () => {},
    mkdirp: async () => {},
  };
}

describe("skillTool", () => {
  it("没有工作区时返回 error（无法定位 .claude/skills/）", async () => {
    setFsAdapter(makeFakeFs({}));
    const ctx: ToolContext = { workspacePath: "" };
    const res = await skillTool.execute({ name: "anything" }, ctx);
    expect(res.status).toBe("error");
    expect(res.error?.code).toBe("TOOL_NOT_FOUND");
    expect(res.error?.retryable).toBe(false);
  });

  it("skill 不存在时返回 error，并在 output 里列出当前可用 skill", async () => {
    setFsAdapter(
      makeFakeFs({
        "/ws/.claude/skills/security-review/SKILL.md":
          "---\nname: security-review\ndescription: 安全审查\n---\n正文。",
      }),
    );
    const ctx: ToolContext = { workspacePath: "/ws" };
    const res = await skillTool.execute({ name: "does-not-exist" }, ctx);
    expect(res.status).toBe("error");
    expect(res.error?.code).toBe("TOOL_NOT_FOUND");
    expect(res.error?.retryable).toBe(true);
    expect(res.output).toContain("security-review");
  });

  it("skill 存在时返回 success，output 含完整 instructions 正文", async () => {
    setFsAdapter(
      makeFakeFs({
        "/ws/.claude/skills/security-review/SKILL.md":
          "---\nname: security-review\ndescription: 对改动做安全审查\n---\n先看认证与输入处理边界。",
      }),
    );
    const ctx: ToolContext = { workspacePath: "/ws" };
    const res = await skillTool.execute({ name: "security-review" }, ctx);
    expect(res.status).toBe("success");
    expect(res.output).toContain("security-review");
    expect(res.output).toContain("对改动做安全审查");
    expect(res.output).toContain("先看认证与输入处理边界。");
    expect(res.summary).toContain("security-review");
  });

  it("只读工具，security.kind = none（不受 K7 phase-capability 门控）", () => {
    expect(skillTool.readOnly).toBe(true);
    expect(skillTool.security).toEqual({ kind: "none" });
  });
});
