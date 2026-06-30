import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  listAll: vi.fn(),
  listByProvider: vi.fn(),
  getProjectMemoryEmbeddingProvider: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  projectMemories: {
    listAll: mocks.listAll,
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
