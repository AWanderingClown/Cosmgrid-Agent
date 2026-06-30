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

import { deleteApiKey, getApiKey, migrateLegacyApiKeys, saveApiKey } from "../keystore";

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
});
