import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@/lib/llm/tools/fs-adapter", () => ({
  getFsAdapter: () => ({ exists: mocks.exists }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const { detectLspServer, languageIdForPath } = await import("../server-detection");

describe("languageIdForPath", () => {
  it.each([
    ["a.ts", "typescript"],
    ["a.mts", "typescript"],
    ["a.cts", "typescript"],
    ["a.tsx", "typescriptreact"],
    ["a.js", "javascript"],
    ["a.jsx", "javascriptreact"],
    ["README", null],
    ["a.py", null],
  ])("maps %s to %s", (path, expected) => {
    expect(languageIdForPath(path)).toBe(expected);
  });
});

describe("detectLspServer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prefers the workspace-local TypeScript language server", async () => {
    mocks.exists.mockResolvedValue(true);
    await expect(detectLspServer("/repo", "/repo/src/a.ts")).resolves.toEqual({
      languageId: "typescript",
      program: "/repo/node_modules/.bin/typescript-language-server",
      args: ["--stdio"],
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("falls back to the global PATH", async () => {
    mocks.exists.mockResolvedValue(false);
    mocks.invoke.mockResolvedValue("/usr/local/bin/typescript-language-server");
    await expect(detectLspServer("/repo", "/repo/src/a.tsx")).resolves.toMatchObject({
      languageId: "typescriptreact",
      program: "/usr/local/bin/typescript-language-server",
    });
  });

  it("returns null for unsupported files or missing servers", async () => {
    await expect(detectLspServer("/repo", "/repo/src/a.py")).resolves.toBeNull();
    mocks.exists.mockRejectedValue(new Error("fs unavailable"));
    mocks.invoke.mockRejectedValue(new Error("not found"));
    await expect(detectLspServer("/repo", "/repo/src/a.js")).resolves.toBeNull();
  });
});
