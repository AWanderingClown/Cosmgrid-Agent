import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildChatMemoryPreambles } from "@/lib/memory/chat-memory-preamble";

const mocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  retrieveCrossProjectMemoriesForPrompt: vi.fn(),
  retrieveProjectMemoriesForPrompt: vi.fn(),
  buildProjectMemoryPreamble: vi.fn(),
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

vi.mock("@/lib/llm/context-preamble", () => ({
  buildProjectMemoryPreamble: mocks.buildProjectMemoryPreamble,
}));

describe("buildChatMemoryPreambles", () => {
  beforeEach(() => {
    mocks.getProjectById.mockReset().mockResolvedValue({ name: "Project A" });
    mocks.retrieveCrossProjectMemoriesForPrompt.mockReset().mockResolvedValue({ preamble: "cross" });
    mocks.retrieveProjectMemoriesForPrompt.mockReset().mockResolvedValue(["memory"]);
    mocks.buildProjectMemoryPreamble.mockReset().mockReturnValue("project memory");
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
    });
    expect(mocks.retrieveProjectMemoriesForPrompt).not.toHaveBeenCalled();
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
    });
    expect(mocks.retrieveCrossProjectMemoriesForPrompt).toHaveBeenCalledWith("project-1", "怎么继续");
    expect(mocks.getProjectById).toHaveBeenCalledWith("project-1");
    expect(mocks.retrieveProjectMemoriesForPrompt).toHaveBeenCalledWith("project-1", "怎么继续");
    expect(mocks.buildProjectMemoryPreamble).toHaveBeenCalledWith("Project A", ["memory"]);
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
  });
});
