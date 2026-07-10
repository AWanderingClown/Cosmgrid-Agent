// 嵌套 CLAUDE.md/AGENTS.md 逐级注入单测（2026-07-10 移植 OMO agents-md-core 思路）。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setFsAdapter, type FsAdapter } from "../fs-adapter";
import { readTool } from "../read-tool";
import { executeTool } from "../executor";
import {
  __resetNestedRulesCacheForTest,
  collectNestedRulesContext,
  MAX_TRACKED_CONVERSATIONS,
} from "../nested-rules-injector";
import type { ToolContext } from "../types";

vi.mock("../../../db", () => ({
  toolExecutions: { create: vi.fn().mockResolvedValue("id") },
}));

const WS = "/ws";

function makeFakeFs(files: Record<string, string>): FsAdapter {
  return {
    readTextFile: async (p) => {
      if (p in files) return files[p]!;
      throw new Error(`ENOENT: ${p}`);
    },
    readBytes: async () => new Uint8Array(0),
    readDir: async () => [],
    exists: async (p) => p in files,
    writeTextFile: async () => {},
    mkdirp: async () => {},
  };
}

beforeEach(() => {
  __resetNestedRulesCacheForTest();
});

describe("嵌套规则注入", () => {
  it("read 命中子目录文件时，追加该目录的 AGENTS.md（根目录不重复注入）", async () => {
    setFsAdapter(
      makeFakeFs({
        "/ws/packages/foo/src/index.ts": "export const x = 1;",
        "/ws/packages/foo/AGENTS.md": "foo 包专属规则：优先用函数式风格。",
        "/ws/AGENTS.md": "根目录规则（应由开场小抄覆盖，不该在这里重复注入）。",
      }),
    );
    const ctx: ToolContext = { workspacePath: WS, conversationId: "conv-1" };
    const r = await executeTool(readTool, { file_path: "packages/foo/src/index.ts" }, ctx);
    expect(r.status).toBe("success");
    expect(r.output).toContain("foo 包专属规则");
    expect(r.output).not.toContain("根目录规则");
  });

  it("同一目录第二次命中不重复注入（会话内去重）", async () => {
    setFsAdapter(
      makeFakeFs({
        "/ws/packages/foo/a.ts": "a",
        "/ws/packages/foo/b.ts": "b",
        "/ws/packages/foo/AGENTS.md": "foo 包专属规则。",
      }),
    );
    const ctx: ToolContext = { workspacePath: WS, conversationId: "conv-2" };
    const r1 = await executeTool(readTool, { file_path: "packages/foo/a.ts" }, ctx);
    const r2 = await executeTool(readTool, { file_path: "packages/foo/b.ts" }, ctx);
    expect(r1.output).toContain("foo 包专属规则");
    expect(r2.output).not.toContain("foo 包专属规则");
  });

  it("不同会话（conversationId 不同）各自独立去重", async () => {
    setFsAdapter(
      makeFakeFs({
        "/ws/packages/foo/a.ts": "a",
        "/ws/packages/foo/AGENTS.md": "foo 包专属规则。",
      }),
    );
    const ctxA: ToolContext = { workspacePath: WS, conversationId: "conv-a" };
    const ctxB: ToolContext = { workspacePath: WS, conversationId: "conv-b" };
    const rA = await executeTool(readTool, { file_path: "packages/foo/a.ts" }, ctxA);
    const rB = await executeTool(readTool, { file_path: "packages/foo/a.ts" }, ctxB);
    expect(rA.output).toContain("foo 包专属规则");
    expect(rB.output).toContain("foo 包专属规则");
  });

  it("没有嵌套规则文件时不追加任何内容", async () => {
    setFsAdapter(makeFakeFs({ "/ws/packages/foo/a.ts": "a" }));
    const ctx: ToolContext = { workspacePath: WS, conversationId: "conv-3" };
    const r = await executeTool(readTool, { file_path: "packages/foo/a.ts" }, ctx);
    expect(r.output).not.toContain("补充规则文件");
  });

  it("会话数超过 MAX_TRACKED_CONVERSATIONS 时按 FIFO 淘汰最早的会话缓存（防止无限增长）", async () => {
    setFsAdapter(
      makeFakeFs({
        "/ws/packages/foo/a.ts": "a",
        "/ws/packages/foo/AGENTS.md": "foo 包专属规则。",
      }),
    );
    const ctxFor = (conversationId: string): ToolContext => ({ workspacePath: WS, conversationId });

    // conv-0 先占一个缓存位，且已经被"看过"（第二次调用应为空）
    const first = await collectNestedRulesContext(ctxFor("conv-0"), "/ws/packages/foo/a.ts");
    expect(first).toContain("foo 包专属规则");
    const secondSameConv = await collectNestedRulesContext(ctxFor("conv-0"), "/ws/packages/foo/a.ts");
    expect(secondSameConv).toBe("");

    // 再灌入 MAX_TRACKED_CONVERSATIONS 个新会话，把 conv-0 挤出缓存
    for (let i = 1; i <= MAX_TRACKED_CONVERSATIONS; i++) {
      await collectNestedRulesContext(ctxFor(`conv-${i}`), "/ws/packages/foo/a.ts");
    }

    // conv-0 的缓存条目应该已被淘汰——同一目录会被当成"没见过"重新注入
    const afterEviction = await collectNestedRulesContext(ctxFor("conv-0"), "/ws/packages/foo/a.ts");
    expect(afterEviction).toContain("foo 包专属规则");
  });
});
