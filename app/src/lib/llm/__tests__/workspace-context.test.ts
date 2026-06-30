// workspace-context 单测：开场读项目自述文件拼 system 小抄（用内存假 fs）
import { describe, it, expect, afterEach } from "vitest";
import { setFsAdapter, tauriFs, type FsAdapter } from "../tools/fs-adapter";
import { buildWorkspacePreamble } from "../workspace-context";

const WS = "/ws";

// 从「绝对路径→内容」map 合成假 FsAdapter；可选 failPaths 模拟读取报错
function makeFakeFs(files: Record<string, string>, failPaths: string[] = []): FsAdapter {
  return {
    exists: async (p) => p in files || failPaths.includes(p),
    readTextFile: async (p) => {
      if (failPaths.includes(p)) throw new Error(`EACCES: ${p}`);
      if (p in files) return files[p]!;
      throw new Error(`ENOENT: ${p}`);
    },
    readDir: async () => [],
    writeTextFile: async () => {},
    mkdirp: async () => {},
  };
}

afterEach(() => setFsAdapter(tauriFs));

describe("buildWorkspacePreamble", () => {
  it("读到 CLAUDE.md 时把内容拼进小抄", async () => {
    setFsAdapter(makeFakeFs({ "/ws/CLAUDE.md": "这是个 Tauri 项目，用 pnpm。" }));
    const out = await buildWorkspacePreamble(WS);
    expect(out).toContain(WS);
    expect(out).toContain("# CLAUDE.md");
    expect(out).toContain("这是个 Tauri 项目");
  });

  it("没有任何自述文件也返回声明工作目录的 header", async () => {
    setFsAdapter(makeFakeFs({}));
    const out = await buildWorkspacePreamble(WS);
    expect(out).toContain(WS);
    expect(out).toContain("文件工具");
    expect(out).toContain("本轮没有写入文件或执行命令的工具");
    expect(out).not.toContain("# CLAUDE.md");
  });

  it("includeWrite=true 时说明可写入和执行命令", async () => {
    setFsAdapter(makeFakeFs({}));
    const out = await buildWorkspacePreamble(WS, { includeWrite: true });
    expect(out).toContain("也能写入文件、执行命令");
    expect(out).toContain("安全确认由应用自动弹窗处理");
  });

  it("多个自述文件按优先级都纳入", async () => {
    setFsAdapter(makeFakeFs({
      "/ws/CLAUDE.md": "soul",
      "/ws/AGENTS.md": "agents",
      "/ws/README.md": "readme",
    }));
    const out = await buildWorkspacePreamble(WS);
    expect(out).toContain("# CLAUDE.md");
    expect(out).toContain("# AGENTS.md");
    expect(out).toContain("# README.md");
  });

  it("超长文件被截断", async () => {
    setFsAdapter(makeFakeFs({ "/ws/CLAUDE.md": "x".repeat(9000) }));
    const out = await buildWorkspacePreamble(WS);
    expect(out).toContain("已截断");
    expect(out.length).toBeLessThan(9000);
  });

  it("单个文件读取失败时安全跳过，不影响其余", async () => {
    setFsAdapter(makeFakeFs({ "/ws/README.md": "readme ok" }, ["/ws/CLAUDE.md"]));
    const out = await buildWorkspacePreamble(WS);
    expect(out).toContain("# README.md");
    expect(out).not.toContain("# CLAUDE.md");
  });

  it("容忍 workspacePath 带尾部斜杠", async () => {
    setFsAdapter(makeFakeFs({ "/ws/CLAUDE.md": "soul" }));
    const out = await buildWorkspacePreamble("/ws/");
    expect(out).toContain("# CLAUDE.md");
  });
});
