import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildChatMemoryPreambles, extractTaskKeywords } from "@/lib/memory/chat-memory-preamble";

const mocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  retrieveCrossProjectMemoriesForPrompt: vi.fn(),
  retrieveProjectMemoriesForPrompt: vi.fn(),
  buildProjectMemoryPreamble: vi.fn(),
  assemblePlaybookContext: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  projects: {
    getById: mocks.getProjectById,
  },
}));

vi.mock("@/lib/memory/retrieval", () => ({
  retrieveCrossProjectMemoriesForPrompt: mocks.retrieveCrossProjectMemoriesForPrompt,
  retrieveProjectMemoriesForPrompt: mocks.retrieveProjectMemoriesForPrompt,
}));

vi.mock("@/lib/llm/prompts/context-preamble", () => ({
  buildProjectMemoryPreamble: mocks.buildProjectMemoryPreamble,
}));

vi.mock("@/lib/llm/playbook/context-assembler", () => ({
  assemblePlaybookContext: mocks.assemblePlaybookContext,
}));

const semanticHit = { id: "mem-semantic", title: "语义命中", content: "c" };

describe("buildChatMemoryPreambles", () => {
  beforeEach(() => {
    mocks.getProjectById.mockReset().mockResolvedValue({ name: "Project A" });
    mocks.retrieveCrossProjectMemoriesForPrompt.mockReset().mockResolvedValue({ preamble: "cross" });
    mocks.retrieveProjectMemoriesForPrompt.mockReset().mockResolvedValue([semanticHit]);
    mocks.buildProjectMemoryPreamble.mockReset().mockReturnValue("project memory");
    mocks.assemblePlaybookContext.mockReset().mockResolvedValue([]);
  });

  it("纯单模型模式不读取项目记忆", async () => {
    const result = await buildChatMemoryPreambles({
      projectId: "project-1",
      text: "hello",
      pureMode: true,
      stopIfAborted: () => false,
    });

    expect(result).toEqual({
      aborted: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      usedMemoryIds: [],
      usedMemories: [],
    });
    expect(mocks.retrieveProjectMemoriesForPrompt).not.toHaveBeenCalled();
    expect(mocks.assemblePlaybookContext).not.toHaveBeenCalled();
  });

  it("有项目时并行读取项目记忆和跨项目记忆并拼前言", async () => {
    const result = await buildChatMemoryPreambles({
      projectId: "project-1",
      text: "怎么继续",
      pureMode: false,
      stopIfAborted: () => false,
    });

    expect(result).toEqual({
      aborted: false,
      projectMemoryPreamble: "project memory",
      crossProjectPreamble: "cross",
      usedMemoryIds: ["mem-semantic"],
      usedMemories: [semanticHit],
    });
    expect(mocks.retrieveCrossProjectMemoriesForPrompt).toHaveBeenCalledWith("project-1", "怎么继续");
    expect(mocks.getProjectById).toHaveBeenCalledWith("project-1");
    expect(mocks.retrieveProjectMemoriesForPrompt).toHaveBeenCalledWith("project-1", "怎么继续");
    expect(mocks.buildProjectMemoryPreamble).toHaveBeenCalledWith("Project A", [semanticHit]);
  });

  it("阶段5 Playbook：加权检索条目与语义 hits 合并去重，语义优先", async () => {
    const playbookOnly = { id: "mem-playbook", title: "加权条目", content: "c" };
    mocks.assemblePlaybookContext.mockResolvedValue([semanticHit, playbookOnly]);

    const result = await buildChatMemoryPreambles({
      projectId: "project-1",
      text: "怎么继续",
      pureMode: false,
      stopIfAborted: () => false,
    });

    // semanticHit 去重不重复；playbookOnly 补足在后
    expect(result.usedMemoryIds).toEqual(["mem-semantic", "mem-playbook"]);
    expect(mocks.buildProjectMemoryPreamble).toHaveBeenCalledWith("Project A", [semanticHit, playbookOnly]);
  });

  it("playbook 加权检索失败不影响语义检索结果（.catch 兜底空数组）", async () => {
    mocks.assemblePlaybookContext.mockRejectedValue(new Error("db busy"));

    const result = await buildChatMemoryPreambles({
      projectId: "project-1",
      text: "hello",
      pureMode: false,
      stopIfAborted: () => false,
    });

    expect(result.projectMemoryPreamble).toBe("project memory");
    expect(result.usedMemoryIds).toEqual(["mem-semantic"]);
  });

  it("读取失败时不阻断主流程", async () => {
    mocks.retrieveProjectMemoriesForPrompt.mockRejectedValue(new Error("db busy"));

    const result = await buildChatMemoryPreambles({
      projectId: "project-1",
      text: "hello",
      pureMode: false,
      stopIfAborted: () => false,
    });

    expect(result).toEqual({
      aborted: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      usedMemoryIds: [],
      usedMemories: [],
    });
  });

  it("读取完成后如果已中止，返回 aborted", async () => {
    const result = await buildChatMemoryPreambles({
      projectId: "project-1",
      text: "hello",
      pureMode: false,
      stopIfAborted: () => true,
    });

    expect(result.aborted).toBe(true);
    expect(result.usedMemoryIds).toEqual([]);
  });
});

describe("extractTaskKeywords", () => {
  it("按标点/空白切段，过滤过短过长，最多 8 段", () => {
    expect(extractTaskKeywords("修复 sqlite 迁移，别动 price-catalog！x")).toEqual([
      "修复",
      "sqlite",
      "迁移",
      "别动",
      "price-catalog",
    ]);
    const many = Array.from({ length: 12 }, (_, i) => `kw${i}`).join(" ");
    expect(extractTaskKeywords(many)).toHaveLength(8);
  });
});
