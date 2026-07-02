// 2.1 步骤2/3 修复（2026-07-02）：影子 git 仓库相关单测
import { describe, it, expect, afterEach } from "vitest";
import { snapshotWrite, enableWorkspaceProtection, setGitSnapshot, type GitSnapshotAdapter } from "../git-snapshot";

const noopAdapter: GitSnapshotAdapter = {
  commitFile: async () => true,
  initShadowRepo: async () => {},
};

afterEach(() => {
  setGitSnapshot(noopAdapter);
});

describe("snapshotWrite", () => {
  it("commitFile 成功 → 返回 true", async () => {
    setGitSnapshot({ commitFile: async () => true, initShadowRepo: async () => {} });
    expect(await snapshotWrite("/ws", "/ws/a.ts", "write")).toBe(true);
  });

  it("commitFile 抛错 → 静默吞掉，返回 false（写操作本身已成功，不能因为快照失败而报错）", async () => {
    setGitSnapshot({
      commitFile: async () => {
        throw new Error("git not found");
      },
      initShadowRepo: async () => {},
    });
    expect(await snapshotWrite("/ws", "/ws/a.ts", "write")).toBe(false);
  });
});

describe("enableWorkspaceProtection", () => {
  it("initShadowRepo 成功 → resolve", async () => {
    let called: string | null = null;
    setGitSnapshot({
      commitFile: async () => true,
      initShadowRepo: async (ws) => {
        called = ws;
      },
    });
    await expect(enableWorkspaceProtection("/ws/project")).resolves.toBeUndefined();
    expect(called).toBe("/ws/project");
  });

  it("initShadowRepo 失败 → 抛错传给调用方（这是用户主动点击的操作，不能静默失败）", async () => {
    setGitSnapshot({
      commitFile: async () => true,
      initShadowRepo: async () => {
        throw new Error("git not installed");
      },
    });
    await expect(enableWorkspaceProtection("/ws/project")).rejects.toThrow("git not installed");
  });
});
