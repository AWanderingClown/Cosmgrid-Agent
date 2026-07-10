// read/glob/grep 工具单测（v0.7 阶段4，用内存假 fs）
//
// L6 安全网收拢（2026-07-09）：checkPath 现在由 executor 按 tool.security 声明统一跑，
// 工具自己不再调用——测试改走 executeTool（跟生产路径一致），不再直接调 tool.execute。
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../../db", () => ({
  toolExecutions: { create: vi.fn().mockResolvedValue("id") },
}));

import { setFsAdapter, type FsAdapter, type FsDirEntry } from "../fs-adapter";
import { readTool } from "../read-tool";
import { globTool } from "../glob-tool";
import { grepTool } from "../grep-tool";
import { executeTool } from "../executor";
import { globToRegExp } from "../walk";
import type { ToolContext } from "../types";

const WS = "/ws";
const ctx: ToolContext = { workspacePath: WS };

// 从「绝对路径→内容」map 合成一个假 FsAdapter
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
      const names = new Map<string, FsDirEntry>();
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

beforeEach(() => {
  setFsAdapter(makeFakeFs({
    "/ws/src/auth.ts": "line1\nline2 TODO fix\nline3",
    "/ws/src/utils/helper.ts": "export const x = 1;\n// TODO refactor",
    "/ws/README.md": "# Project\nsome docs",
    "/ws/node_modules/pkg/index.js": "TODO should be ignored",
  }));
});

describe("read 工具", () => {
  it("读文件返回带行号内容", async () => {
    const r = await executeTool(readTool, { file_path: "src/auth.ts" }, ctx);
    expect(r.status).toBe("success");
    expect(r.output).toContain("1\tline1");
    expect(r.output).toContain("3 行");
  });

  it("offset/limit 截取", async () => {
    const r = await executeTool(readTool, { file_path: "src/auth.ts", offset: 2, limit: 1 }, ctx);
    expect(r.output).toContain("2\tline2 TODO fix");
    expect(r.output).not.toContain("line1");
  });

  it("越界路径拒绝", async () => {
    const r = await executeTool(readTool, { file_path: "../../etc/passwd" }, ctx);
    expect(r.status).toBe("denied");
  });

  it("敏感路径拒绝", async () => {
    const r = await executeTool(readTool, { file_path: ".env" }, ctx);
    expect(r.status).toBe("denied");
  });

  it("不存在的文件 → error", async () => {
    const r = await executeTool(readTool, { file_path: "src/nope.ts" }, ctx);
    expect(r.status).toBe("error");
  });
});

describe("globToRegExp", () => {
  it("** 跨目录匹配", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
  });
  it("* 不跨目录", () => {
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
  });
});

describe("glob 工具", () => {
  it("匹配 ts 文件，忽略 node_modules", async () => {
    const r = await executeTool(globTool, { pattern: "**/*.ts" }, ctx);
    expect(r.output).toContain("src/auth.ts");
    expect(r.output).toContain("src/utils/helper.ts");
    expect(r.output).not.toContain("node_modules");
  });

  it("无匹配返回提示", async () => {
    const r = await executeTool(globTool, { pattern: "**/*.py" }, ctx);
    expect(r.output).toMatch(/没有匹配/);
  });

  it("尊重 .gitignore：排除的目录不被搜到（修复一头扎进 技术参考/ 的 bug）", async () => {
    setFsAdapter(makeFakeFs({
      "/ws/.gitignore": "/技术参考/\n/项目文档/\nbuild/",
      "/ws/app/src/db.ts": "export const db = 1;",
      "/ws/技术参考/opencode/huge.ts": "noise",
      "/ws/项目文档/plan.ts": "noise",
      "/ws/build/out.ts": "noise",
    }));
    const r = await executeTool(globTool, { pattern: "**/*.ts" }, ctx);
    expect(r.output).toContain("app/src/db.ts"); // 真源码搜得到
    expect(r.output).not.toContain("技术参考"); // gitignore 排除目录不下钻
    expect(r.output).not.toContain("项目文档");
    expect(r.output).not.toContain("build/out.ts");
  });
});

describe("grep 工具", () => {
  it("搜 TODO，跳过 node_modules", async () => {
    const r = await executeTool(grepTool, { pattern: "TODO" }, ctx);
    expect(r.output).toContain("src/auth.ts:2");
    expect(r.output).toContain("src/utils/helper.ts:2");
    expect(r.output).not.toContain("node_modules");
  });

  it("include 限定文件类型", async () => {
    const r = await executeTool(grepTool, { pattern: "TODO", include: "*.ts" }, ctx);
    expect(r.output).toContain("auth.ts");
  });

  it("非法正则 → error", async () => {
    const r = await executeTool(grepTool, { pattern: "[invalid(" }, ctx);
    expect(r.status).toBe("error");
  });

  it("无匹配返回提示", async () => {
    const r = await executeTool(grepTool, { pattern: "NONEXISTENT_XYZ" }, ctx);
    expect(r.output).toMatch(/没有匹配/);
  });
});
