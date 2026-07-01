// path-safety 单测（v0.7 阶段4：路径边界 + 敏感路径，安全关键）
import { describe, it, expect } from "vitest";
import { normalizePath, resolveInWorkspace, isSensitivePath, checkPath, checkWritePath } from "../path-safety";

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

describe("checkWritePath — 写类工具专用，工作区外放行但标记 external", () => {
  it("工作区内 → 放行，external=false", () => {
    const r = checkWritePath(WS, "src/auth.ts");
    expect(r.ok).toBe(true);
    expect(r.external).toBe(false);
  });

  it("workspace 根本身 → 放行，external=false", () => {
    expect(checkWritePath(WS, ".").external).toBe(false);
  });

  it("工作区外的绝对路径（如桌面）→ 放行，external=true（不再像 checkPath 那样硬拒绝）", () => {
    const r = checkWritePath(WS, "/Users/me/Desktop/plan.md");
    expect(r.ok).toBe(true);
    expect(r.external).toBe(true);
    expect(r.resolved).toBe("/Users/me/Desktop/plan.md");
  });

  it("路径遍历到工作区外 → 放行，external=true", () => {
    const r = checkWritePath(WS, "../../etc/motd");
    expect(r.ok).toBe(true);
    expect(r.external).toBe(true);
  });

  it("前缀相同但不在子目录下的兄弟目录 → 放行，external=true", () => {
    const r = checkWritePath(WS, "/Users/me/projects/foobar/x");
    expect(r.ok).toBe(true);
    expect(r.external).toBe(true);
  });

  it("敏感路径 → 不管在不在工作区内，一律拒绝（这条不因为 external 而放松）", () => {
    expect(checkWritePath(WS, ".env").ok).toBe(false);
    expect(checkWritePath("/Users/me/Desktop", ".ssh/id_rsa").ok).toBe(false);
  });
});
