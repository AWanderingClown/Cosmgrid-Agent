// path-safety 单测（v0.7 阶段4：路径边界 + 敏感路径，安全关键）
import { describe, it, expect } from "vitest";
import { normalizePath, resolveInWorkspace, isSensitivePath, checkPath } from "../path-safety";

const WS = "/Users/me/projects/foo";

describe("normalizePath", () => {
  it("折叠 . 和 ..", () => {
    expect(normalizePath("/a/b/../c")).toBe("/a/c");
    expect(normalizePath("/a/./b")).toBe("/a/b");
  });
  it("绝对路径越根的 .. 被吞", () => {
    expect(normalizePath("/a/../../b")).toBe("/b");
  });
  it("多斜杠归一", () => {
    expect(normalizePath("/a//b///c")).toBe("/a/b/c");
  });
});

describe("resolveInWorkspace", () => {
  it("相对路径接在 workspace 后", () => {
    expect(resolveInWorkspace(WS, "src/auth.ts")).toBe(`${WS}/src/auth.ts`);
  });
  it("绝对路径原样规范化", () => {
    expect(resolveInWorkspace(WS, "/etc/passwd")).toBe("/etc/passwd");
  });
});

describe("checkPath — 边界", () => {
  it("工作区内允许", () => {
    expect(checkPath(WS, "src/auth.ts").ok).toBe(true);
  });
  it("workspace 根本身允许", () => {
    expect(checkPath(WS, ".").ok).toBe(true);
  });
  it("路径遍历越界拒绝", () => {
    const r = checkPath(WS, "../../etc/passwd");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/越出/);
  });
  it("绝对路径越界拒绝", () => {
    expect(checkPath(WS, "/etc/passwd").ok).toBe(false);
  });
  it("前缀相同但不在子目录下的兄弟目录拒绝", () => {
    // /Users/me/projects/foobar 不应被当成 /Users/me/projects/foo 的子路径
    expect(checkPath(WS, "/Users/me/projects/foobar/x").ok).toBe(false);
  });
});

describe("isSensitivePath / checkPath — 敏感路径", () => {
  it.each([
    "src/.env",
    ".env.local",
    "config/secrets.json",
    "deploy/secret.yaml",
    ".ssh/id_rsa",
    "keystore.json",
  ])("拒绝敏感：%s", (p) => {
    expect(checkPath(WS, p).ok).toBe(false);
  });

  it("普通源码文件不敏感", () => {
    expect(isSensitivePath(`${WS}/src/index.ts`)).toBe(false);
    expect(checkPath(WS, "src/index.ts").ok).toBe(true);
  });
});
