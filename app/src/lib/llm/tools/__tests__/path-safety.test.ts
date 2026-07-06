// path-safety 单测（v0.7 阶段4：路径边界 + 敏感路径，安全关键）
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  normalizePath,
  resolveInWorkspace,
  isSensitivePath,
  checkPath,
  checkWritePath,
  setDefaultRealpathFn,
  getDefaultRealpathFn,
} from "../path-safety";

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
  it("工作区内允许", async () => {
    expect((await checkPath(WS, "src/auth.ts")).ok).toBe(true);
  });
  it("workspace 根本身允许", async () => {
    expect((await checkPath(WS, ".")).ok).toBe(true);
  });
  it("路径遍历越界拒绝", async () => {
    const r = await checkPath(WS, "../../etc/passwd");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/越出/);
  });
  it("绝对路径越界拒绝", async () => {
    expect((await checkPath(WS, "/etc/passwd")).ok).toBe(false);
  });
  it("前缀相同但不在子目录下的兄弟目录拒绝", async () => {
    // /Users/me/projects/foobar 不应被当成 /Users/me/projects/foo 的子路径
    expect((await checkPath(WS, "/Users/me/projects/foobar/x")).ok).toBe(false);
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
  ])("拒绝敏感：%s", async (p) => {
    expect((await checkPath(WS, p)).ok).toBe(false);
  });

  it("普通源码文件不敏感", async () => {
    expect(isSensitivePath(`${WS}/src/index.ts`)).toBe(false);
    expect((await checkPath(WS, "src/index.ts")).ok).toBe(true);
  });
});

describe("checkWritePath — 写类工具专用，工作区外放行但标记 external", () => {
  it("工作区内 → 放行，external=false", async () => {
    const r = await checkWritePath(WS, "src/auth.ts");
    expect(r.ok).toBe(true);
    expect(r.external).toBe(false);
  });

  it("workspace 根本身 → 放行，external=false", async () => {
    expect((await checkWritePath(WS, ".")).external).toBe(false);
  });

  it("工作区外的绝对路径（如桌面）→ 放行，external=true（不再像 checkPath 那样硬拒绝）", async () => {
    const r = await checkWritePath(WS, "/Users/me/Desktop/plan.md");
    expect(r.ok).toBe(true);
    expect(r.external).toBe(true);
    expect(r.resolved).toBe("/Users/me/Desktop/plan.md");
  });

  it("路径遍历到工作区外 → 放行，external=true", async () => {
    const r = await checkWritePath(WS, "../../etc/motd");
    expect(r.ok).toBe(true);
    expect(r.external).toBe(true);
  });

  it("前缀相同但不在子目录下的兄弟目录 → 放行，external=true", async () => {
    const r = await checkWritePath(WS, "/Users/me/projects/foobar/x");
    expect(r.ok).toBe(true);
    expect(r.external).toBe(true);
  });

  it("敏感路径 → 不管在不在工作区内，一律拒绝（这条不因为 external 而放松）", async () => {
    expect((await checkWritePath(WS, ".env")).ok).toBe(false);
    expect((await checkWritePath("/Users/me/Desktop", ".ssh/id_rsa")).ok).toBe(false);
  });
});

// ============ 2.2 修复：符号链接解析（realpath 注入）============

describe("path-safety — 符号链接逃逸防护（2.2 修复）", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let sensitiveDir: string;
  let previousDefaultRealpath: ReturnType<typeof getDefaultRealpathFn>;

  beforeAll(() => {
    // 创建测试目录结构：
    //   tmpDir/
    //     project/                ← workspace
        //       link-to-ssh -> ../ssh/
    //       link-internal -> ./real-file.txt
    //       real-file.txt
    //       internal-dir/
    //     ssh/                     ← 模拟 ~/.ssh（敏感）
    //       id_rsa
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "path-safety-symlink-test-"));
    workspaceDir = path.join(tmpDir, "project");
    sensitiveDir = path.join(tmpDir, "ssh");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(sensitiveDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "real-file.txt"), "content");
    fs.writeFileSync(path.join(sensitiveDir, "id_rsa"), "fake-key");
    fs.mkdirSync(path.join(workspaceDir, "internal-dir"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "internal-dir", "x.txt"), "x");
    // 创建符号链接：workspace 内 link 指向 workspace 外的 ssh/
    fs.symlinkSync(
      path.join(sensitiveDir, "id_rsa"),
      path.join(workspaceDir, "link-to-ssh"),
    );
    // 创建符号链接：workspace 内 link 指向 workspace 内
    fs.symlinkSync(
      path.join(workspaceDir, "real-file.txt"),
      path.join(workspaceDir, "link-internal"),
    );

    // 测试前先保存现有 default realpath（避免污染其他测试）
    previousDefaultRealpath = getDefaultRealpathFn();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setDefaultRealpathFn(previousDefaultRealpath);
  });

  it("不注入 realpathFn → 字符串检查仍生效（链接名 'link-to-ssh' 被认为在工作区内）", async () => {
    // 链接名 "link-to-ssh" 看起来在工作区内，字符串检查放行——这就是 2.2 描述的逃逸路径
    const r = await checkPath(workspaceDir, "link-to-ssh");
    expect(r.ok).toBe(true); // 字符串检查放行（这是逃逸漏洞）
  });

  it("checkPath 注入 realpathFn → 工作区内符号链接指向 workspace 外敏感路径 → 拒绝", async () => {
    const r = await checkPath(workspaceDir, "link-to-ssh", {
      realpathFn: (p) => fs.realpathSync(p),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/越出/);
  });

  it("checkWritePath 注入 realpathFn → 同样拒绝（写类工具防护）", async () => {
    const r = await checkWritePath(workspaceDir, "link-to-ssh", {
      realpathFn: (p) => fs.realpathSync(p),
    });
    expect(r.ok).toBe(false);
  });

  it("工作区内符号链接指向工作区内 → 仍允许", async () => {
    const r = await checkPath(workspaceDir, "link-internal", {
      realpathFn: (p) => fs.realpathSync(p),
    });
    expect(r.ok).toBe(true);
    // macOS 上 /var → /private/var，resolved 用 realpath 形式
    const expectedResolved = fs.realpathSync(path.join(workspaceDir, "real-file.txt"));
    expect(r.resolved).toBe(expectedResolved);
  });

  it("不存在的路径 → realpath 抛错 → safeRealpath 落回原路径（让 fs 操作自然报错）", async () => {
    const r = await checkPath(workspaceDir, "this-file-does-not-exist.txt", {
      realpathFn: (p) => fs.realpathSync(p),
    });
    // 落回原路径后，原路径在工作区内 + 不敏感 → ok=true（让下游 fs 操作报 ENOENT）
    expect(r.ok).toBe(true);
  });

  it("realpathFn=null → 显式禁用 realpath（保持字符串检查语义）", async () => {
    // 用户如果想保持原有字符串检查行为，传 null 禁用
    const r = await checkPath(workspaceDir, "link-to-ssh", { realpathFn: null });
    expect(r.ok).toBe(true);
  });

  it("全局 setDefaultRealpathFn → 后续 checkPath 调用自动应用（应用启动时一次性注入）", async () => {
    setDefaultRealpathFn((p) => fs.realpathSync(p));
    expect(getDefaultRealpathFn()).toBeDefined();
    const r = await checkPath(workspaceDir, "link-to-ssh"); // 不传 options，用全局
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/越出/);
  });

  it("全局 realpathFn 是异步函数（模拟 Tauri invoke）→ checkPath 正确 await", async () => {
    // 2.2 修复补丁：生产环境的 realpathFn 走 Tauri invoke，是真正的 Promise，
    // 不是同步函数——这里模拟这个场景，确保 resolveBoth 正确 await 而不是把
    // Promise 对象当字符串用（那样 .startsWith 会直接抛错或产生错误的比较结果）。
    setDefaultRealpathFn(async (p) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return fs.realpathSync(p);
    });
    const r = await checkPath(workspaceDir, "link-to-ssh");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/越出/);
  });
});
