import { describe, expect, it } from "vitest";
import { setFsAdapter, type FsAdapter } from "../../tools/fs-adapter";
import { loadClaudeCodeCommands } from "../command-loader";

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

describe("loadClaudeCodeCommands", () => {
  it("没有 .claude/commands 目录时返回空数组", async () => {
    setFsAdapter(makeFakeFs({}));
    expect(await loadClaudeCodeCommands("/ws")).toEqual([]);
  });

  it("读取顶层命令文件，解析 frontmatter + 正文", async () => {
    setFsAdapter(
      makeFakeFs({
        "/ws/.claude/commands/review.md": "---\ndescription: 代码审查\n---\n先看 git diff",
      }),
    );
    const commands = await loadClaudeCodeCommands("/ws");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      name: "review",
      description: "代码审查",
      template: "先看 git diff",
    });
  });

  it("嵌套子目录的命令名用 / 拼接（如 git/commit）", async () => {
    setFsAdapter(
      makeFakeFs({
        "/ws/.claude/commands/git/commit.md": "---\ndescription: 提交\n---\ngit commit",
      }),
    );
    const commands = await loadClaudeCodeCommands("/ws");
    expect(commands[0]?.name).toBe("git/commit");
  });

  it("model / argument-hint 字段能正确解析", async () => {
    setFsAdapter(
      makeFakeFs({
        "/ws/.claude/commands/deploy.md":
          '---\ndescription: 部署\nmodel: claude-opus-4-8\nargument-hint: "<env>"\n---\n部署到 $ARGUMENTS',
      }),
    );
    const commands = await loadClaudeCodeCommands("/ws");
    expect(commands[0]?.model).toBe("claude-opus-4-8");
    expect(commands[0]?.argumentHint).toBe("<env>");
    expect(commands[0]?.template).toContain("$ARGUMENTS");
  });

  it("多个命令文件都能读到", async () => {
    setFsAdapter(
      makeFakeFs({
        "/ws/.claude/commands/a.md": "---\ndescription: A\n---\nbodyA",
        "/ws/.claude/commands/b.md": "---\ndescription: B\n---\nbodyB",
      }),
    );
    const commands = await loadClaudeCodeCommands("/ws");
    expect(commands.map((c) => c.name).sort()).toEqual(["a", "b"]);
  });
});
