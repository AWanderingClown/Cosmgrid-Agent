import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const data = new Map<string, string>();
  const store = {
    set: vi.fn(async (key: string, value: unknown) => {
      data.set(key, String(value));
    }),
    get: vi.fn(async <T,>(key: string): Promise<T | undefined> => data.get(key) as T | undefined),
    delete: vi.fn(async (key: string) => data.delete(key)),
    keys: vi.fn(async () => Array.from(data.keys())),
    save: vi.fn(async () => {}),
  };
  return {
    data,
    store,
    invoke: vi.fn(),
    load: vi.fn(async () => store),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  Store: {
    load: mocks.load,
  },
}));

import {
  __clearApiKeyMemoryCacheForTests,
  deleteApiKey,
  getApiKey,
  migrateLegacyApiKeys,
  saveApiKey,
} from "../keystore";

describe("keystore", () => {
  beforeEach(() => {
    mocks.data.clear();
    mocks.invoke.mockReset();
    mocks.store.set.mockClear();
    mocks.store.get.mockClear();
    mocks.store.delete.mockClear();
    mocks.store.keys.mockClear();
    mocks.store.save.mockClear();
    mocks.load.mockClear();
    // 修复（2026-07-02）：getApiKey 现在有内存缓存，模块级 Map 会跨用例残留，
    // 每个用例开始前清空，避免上一个用例写的 key 污染下一个用例的断言。
    __clearApiKeyMemoryCacheForTests();
  });

  it("saves new API keys to the system credential store and clears legacy plaintext", async () => {
    await saveApiKey("cred-1", "sk-test");

    expect(mocks.invoke).toHaveBeenCalledWith("save_api_key", {
      credentialId: "cred-1",
      apiKey: "sk-test",
    });
    expect(mocks.store.delete).toHaveBeenCalledWith("apiKey:cred-1");
    expect(mocks.store.save).toHaveBeenCalled();
  });

  it("reads from keychain first", async () => {
    mocks.invoke.mockResolvedValueOnce("sk-keychain");

    await expect(getApiKey("cred-1")).resolves.toBe("sk-keychain");
    expect(mocks.invoke).toHaveBeenCalledWith("get_api_key", { credentialId: "cred-1" });
    expect(mocks.store.get).not.toHaveBeenCalled();
  });

  it("lazily migrates a legacy plaintext key when keychain is missing it", async () => {
    mocks.data.set("apiKey:cred-1", "sk-legacy");
    mocks.invoke
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(undefined);

    await expect(getApiKey("cred-1")).resolves.toBe("sk-legacy");

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "get_api_key", { credentialId: "cred-1" });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "save_api_key", {
      credentialId: "cred-1",
      apiKey: "sk-legacy",
    });
    expect(mocks.store.delete).toHaveBeenCalledWith("apiKey:cred-1");
  });

  it("migrates only valid legacy credential ids and leaves failed rows recoverable", async () => {
    mocks.data.set("apiKey:valid-1", "sk-1");
    mocks.data.set("apiKey:valid-2", "sk-2");
    mocks.data.set("apiKey:orphan", "sk-old");
    mocks.invoke.mockImplementation(async (_cmd: string, args: { credentialId: string }) => {
      if (args.credentialId === "valid-2") throw new Error("keychain locked");
      return undefined;
    });

    await expect(migrateLegacyApiKeys(["valid-1", "valid-2"])).resolves.toEqual({
      migrated: 1,
      skipped: 1,
      failed: 1,
    });

    expect(mocks.store.delete).toHaveBeenCalledWith("apiKey:valid-1");
    expect(mocks.store.delete).not.toHaveBeenCalledWith("apiKey:valid-2");
    expect(mocks.store.delete).not.toHaveBeenCalledWith("apiKey:orphan");
    expect(mocks.store.save).toHaveBeenCalledTimes(1);
  });

  it("deletes from both keychain and legacy store", async () => {
    await deleteApiKey("cred-1");

    expect(mocks.invoke).toHaveBeenCalledWith("delete_api_key", { credentialId: "cred-1" });
    expect(mocks.store.delete).toHaveBeenCalledWith("apiKey:cred-1");
  });

  // 修复（2026-07-02）：用户反馈每次切模型/发消息/新建对话都弹一次 macOS 钥匙串授权框——
  // 根因是 getApiKey 完全不缓存，每次都真打一次 Keychain。这几个用例锁定"同一次运行内
  // 一个 credential 只真正问一次钥匙串"这个行为，防止以后有人无意间把缓存去掉。
  describe("内存缓存（防止每次都真打一次 Keychain）", () => {
    it("同一 credentialId 连续调用两次 getApiKey，只真正调用一次 invoke", async () => {
      mocks.invoke.mockResolvedValueOnce("sk-keychain");

      await expect(getApiKey("cred-1")).resolves.toBe("sk-keychain");
      await expect(getApiKey("cred-1")).resolves.toBe("sk-keychain");

      expect(mocks.invoke).toHaveBeenCalledTimes(1);
    });

    it("saveApiKey 之后立刻 getApiKey 同一 credentialId，直接读内存不再调用 invoke 的 get_api_key", async () => {
      await saveApiKey("cred-1", "sk-new");
      mocks.invoke.mockClear();

      await expect(getApiKey("cred-1")).resolves.toBe("sk-new");
      expect(mocks.invoke).not.toHaveBeenCalled();
    });

    it("deleteApiKey 之后再 getApiKey 同一 credentialId，缓存已清，会重新真打一次 Keychain", async () => {
      mocks.invoke.mockResolvedValueOnce("sk-keychain");
      await getApiKey("cred-1");

      await deleteApiKey("cred-1");
      mocks.invoke.mockClear();
      mocks.invoke.mockResolvedValueOnce(null);

      await getApiKey("cred-1");
      expect(mocks.invoke).toHaveBeenCalledWith("get_api_key", { credentialId: "cred-1" });
    });

    it("不同 credentialId 各自独立缓存，互不影响", async () => {
      mocks.invoke.mockResolvedValueOnce("sk-a").mockResolvedValueOnce("sk-b");

      await expect(getApiKey("cred-a")).resolves.toBe("sk-a");
      await expect(getApiKey("cred-b")).resolves.toBe("sk-b");
      expect(mocks.invoke).toHaveBeenCalledTimes(2);

      // 再各自查一次，都应该走缓存，不再新增 invoke 调用
      await getApiKey("cred-a");
      await getApiKey("cred-b");
      expect(mocks.invoke).toHaveBeenCalledTimes(2);
    });
  });
});
