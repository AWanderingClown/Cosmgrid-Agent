import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  listAll: vi.fn(),
  listByProvider: vi.fn(),
  getProjectMemoryEmbeddingProvider: vi.fn(),
  listByProject: vi.fn(),
  searchWithinProject: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  projectMemories: {
    listAll: mocks.listAll,
    listByProject: mocks.listByProject,
    searchWithinProject: mocks.searchWithinProject,
  },
  projectMemoryVectors: {
    listByProvider: mocks.listByProvider,
  },
}));

vi.mock("../embedding-provider", () => ({
  getProjectMemoryEmbeddingProvider: mocks.getProjectMemoryEmbeddingProvider,
}));

describe("project memory vector backfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAll.mockResolvedValue([]);
    mocks.listByProvider.mockResolvedValue([]);
  });

  it("不会在聊天热路径为远程 embedding 自动补索引", async () => {
    mocks.getProjectMemoryEmbeddingProvider.mockResolvedValue({
      name: "remote-openai-embedding:cred:text-embedding-3-small",
      dim: 0,
      supportsHotBackfill: false,
      embed: vi.fn(),
    });
    const { backfillProjectMemoryVectors } = await import("../retrieval");

    await expect(backfillProjectMemoryVectors()).resolves.toBe(0);
    expect(mocks.listAll).not.toHaveBeenCalled();
  });
});

describe("retrieveProjectMemoriesForPrompt（同项目记忆按相关性排序）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("关键词命中的记忆排在前面，剩余名额用 importance/时间排序补齐且不重复", async () => {
    mocks.searchWithinProject.mockResolvedValue([{ id: "relevant-1", title: "相关记忆" }]);
    mocks.listByProject.mockResolvedValue([
      { id: "relevant-1", title: "相关记忆" },
      { id: "old-1", title: "旧记忆1" },
      { id: "old-2", title: "旧记忆2" },
    ]);
    const { retrieveProjectMemoriesForPrompt } = await import("../retrieval");

    const result = await retrieveProjectMemoriesForPrompt("proj-1", "这句话跟相关记忆有关", { limit: 2 });

    expect(result.map((m) => m.id)).toEqual(["relevant-1", "old-1"]);
  });

  it("没有关键词命中时，完全回退到 listByProject 的排序", async () => {
    mocks.searchWithinProject.mockResolvedValue([]);
    mocks.listByProject.mockResolvedValue([
      { id: "old-1", title: "旧记忆1" },
      { id: "old-2", title: "旧记忆2" },
    ]);
    const { retrieveProjectMemoriesForPrompt } = await import("../retrieval");

    const result = await retrieveProjectMemoriesForPrompt("proj-1", "无关的一句话", { limit: 2 });

    expect(result.map((m) => m.id)).toEqual(["old-1", "old-2"]);
  });
});
