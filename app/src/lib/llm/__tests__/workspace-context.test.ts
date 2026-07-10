// workspace-context 单测：开场读项目自述文件拼 system 小抄（用内存假 fs）
import { describe, it, expect, afterEach } from "vitest";
import { setFsAdapter, tauriFs, type FsAdapter, type FsDirEntry } from "../tools/fs-adapter";
import { buildWorkspacePreamble } from "../workspace-context";

const WS = "/ws";

// 从「绝对路径→内容」map 合成假 FsAdapter；可选 failPaths 模拟读取报错，dirs 模拟目录列表
function makeFakeFs(
  files: Record<string, string>,
  failPaths: string[] = [],
  dirs: Record<string, FsDirEntry[]> = {},
): FsAdapter {
  return {
    exists: async (p) => p in files || failPaths.includes(p),
    readTextFile: async (p) => {
      if (failPaths.includes(p)) throw new Error(`EACCES: ${p}`);
      if (p in files) return files[p]!;
      throw new Error(`ENOENT: ${p}`);
    },
    readBytes: async () => new Uint8Array(0),
    readDir: async (p) => dirs[p] ?? [],
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

  it("提示模型探索时并行发起多个互不依赖的工具调用，别一轮只查一件事（修慢吞吞探索 20 轮的问题）", async () => {
    setFsAdapter(makeFakeFs({}));
    const out = await buildWorkspacePreamble(WS);
    expect(out).toContain("同时发起多个互不依赖的工具调用");
  });

  it("includeWrite=true 时说明可写入和执行命令", async () => {
    setFsAdapter(makeFakeFs({}));
    const out = await buildWorkspacePreamble(WS, { includeWrite: true });
    expect(out).toContain("也能写入文件、执行命令");
    expect(out).toContain("安全确认由应用自动弹窗处理");
  });

  it("includeWrite=true + 传了 desktopPath → preamble 里告诉模型桌面路径，可直接用 write 工具（修：AI 自己不知道能存桌面的隐形分身 bug）", async () => {
    setFsAdapter(makeFakeFs({}));
    const out = await buildWorkspacePreamble(WS, { includeWrite: true, desktopPath: "/Users/me/Desktop" });
    expect(out).toContain("/Users/me/Desktop");
    expect(out).toContain("直接用 write 工具写这个路径下的文件");
  });

  it("只读模式（includeWrite=false）就算传了 desktopPath 也不提——反正没有写工具可用", async () => {
    setFsAdapter(makeFakeFs({}));
    const out = await buildWorkspacePreamble(WS, { includeWrite: false, desktopPath: "/Users/me/Desktop" });
    expect(out).not.toContain("/Users/me/Desktop");
  });

  it("没传 desktopPath 时不提桌面这件事，preamble 跟改造前一样", async () => {
    setFsAdapter(makeFakeFs({}));
    const out = await buildWorkspacePreamble(WS, { includeWrite: true });
    expect(out).not.toContain("桌面");
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

  it("附带工作目录浅层结构，开场就让模型知道根目录下真实有什么（修：没有这张地图时模型瞎猜 glob 猜不中，误判'没有源码'）", async () => {
    setFsAdapter(makeFakeFs({}, [], {
      "/ws": [
        { name: "app", isDirectory: true, isFile: false },
        { name: "package.json", isDirectory: false, isFile: true },
      ],
      "/ws/app": [
        { name: "src", isDirectory: true, isFile: false },
      ],
    }));
    const out = await buildWorkspacePreamble(WS);
    expect(out).toContain("浅层结构");
    expect(out).toContain("app/");
    expect(out).toContain("app/src/");
    expect(out).toContain("package.json");
  });

  it("目录列不出来时（比如空目录）不附带浅层结构小节，也不影响其余内容", async () => {
    setFsAdapter(makeFakeFs({ "/ws/CLAUDE.md": "soul" }));
    const out = await buildWorkspacePreamble(WS);
    expect(out).not.toContain("浅层结构");
    expect(out).toContain("# CLAUDE.md");
  });
});
