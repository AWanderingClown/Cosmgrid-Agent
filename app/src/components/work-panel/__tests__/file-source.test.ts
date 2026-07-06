import { describe, expect, it } from "vitest";
import { resolveWorkspaceFilePath } from "../file-source";

describe("resolveWorkspaceFilePath", () => {
  it("绝对路径保持不变", () => {
    expect(resolveWorkspaceFilePath("/Users/me/app", "/tmp/a.ts")).toBe("/tmp/a.ts");
  });

  it("相对路径拼到工作区下", () => {
    expect(resolveWorkspaceFilePath("/Users/me/app/", "src/main.tsx")).toBe("/Users/me/app/src/main.tsx");
  });

  it("没有工作区时返回原路径", () => {
    expect(resolveWorkspaceFilePath(null, "src/main.tsx")).toBe("src/main.tsx");
  });
});
