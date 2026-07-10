import { describe, expect, it } from "vitest";
import { setFsAdapter, type FsAdapter } from "../../tools/fs-adapter";
import { loadClaudeCodeAgents } from "../agent-loader";

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

describe("loadClaudeCodeAgents", () => {
  it("没有 .claude/agents 目录时返回空数组", async () => {
    setFsAdapter(makeFakeFs({}));
    expect(await loadClaudeCodeAgents("/ws")).toEqual([]);
  });

  it("解析 name/description/tools/model + systemPrompt 正文", async () => {
    setFsAdapter(
      makeFakeFs({
        "/ws/.claude/agents/reviewer.md":
          "---\nname: code-reviewer\ndescription: 代码审查专家\nmodel: claude-opus-4-8\ntools: Read, Grep, Bash\n---\n你是一个严格的代码审查者。",
      }),
    );
    const agents = await loadClaudeCodeAgents("/ws");
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      name: "code-reviewer",
      description: "代码审查专家",
      model: "claude-opus-4-8",
      tools: ["Read", "Grep", "Bash"],
      systemPrompt: "你是一个严格的代码审查者。",
    });
  });

  it("frontmatter 没有 name 字段时用文件名兜底", async () => {
    setFsAdapter(
      makeFakeFs({
        "/ws/.claude/agents/planner.md": "---\ndescription: 规划\n---\n你是规划专家。",
      }),
    );
    const agents = await loadClaudeCodeAgents("/ws");
    expect(agents[0]?.name).toBe("planner");
  });

  it("单个 agent 文件损坏不影响其余 agent 加载", async () => {
    const fs = makeFakeFs({
      "/ws/.claude/agents/good.md": "---\ndescription: 正常\n---\n正文",
      "/ws/.claude/agents/bad.md": "---\ndescription: 坏文件\n---\n正文",
    });
    // 模拟 bad.md 读取抛错
    const original = fs.readTextFile;
    fs.readTextFile = async (p) => {
      if (p.endsWith("bad.md")) throw new Error("读取失败");
      return original(p);
    };
    setFsAdapter(fs);
    const agents = await loadClaudeCodeAgents("/ws");
    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe("good");
  });
});
