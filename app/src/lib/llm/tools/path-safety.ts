// v0.7 阶段4 — 路径安全（工具读写的第一道防线）
//
// 规则（按 v2 方案的默认 deny 列表）：
//   1. 解析后的绝对路径必须在 workspace 之下（防路径遍历 ../../）
//   2. 默认拒绝敏感路径：.ssh / .aws / .gnupg / .env* / secrets.* / keystore.json
//      （实际正则已搬到 lib/security-invariants/sensitive-paths.ts：阶段 3 R7 集中）
//
// 2.2 修复（2026-07-02）：可选 realpath 解析，避免符号链接逃逸。
//   - 路径前缀全用字符串检查，但符号链接可以指向 workspace 之外的敏感路径（.ssh / .aws 等），
//     字符串检查只看链接名本身，无法识别真实指向。
//   - 解决：在做边界比较前，先用 realpath 解析成真实目标路径，再比较。
//   - 默认行为保持兼容（不传 realpathFn = 字符串检查），仅在显式注入时启用。
//
// 2.2 修复补丁（2026-07-02）：realpath 函数改成异步。
//   Tauri 渲染进程是 WKWebView，既不是 Node.js 运行时也不是浏览器——`node:fs` 不会被
//   打包也不会在运行时 resolve，之前用 `import("node:fs")` 注入的方式在生产构建里
//   会静默失败，这个防护实际上从未生效。真正能做 realpath 解析的只有 Rust 侧，
//   通过 Tauri `invoke("resolve_realpath", ...)` 桥接，而 Tauri IPC 调用必然是异步的，
//   所以 RealpathFn 和 checkPath/checkWritePath 都跟着改成 async。

/**
 * realpath 函数类型：给定路径字符串，返回真实路径字符串（解析符号链接）。
 * 抛错/reject 会被 resolveBoth 内部 catch（落回原路径），调用方不需要自己 try-catch。
 */
export type RealpathFn = (p: string) => string | Promise<string>;

/**
 * 应用启动时调用：注入 realpath 实现。生产环境用 Tauri `resolve_realpath` command
 * （见 main.tsx），因为只有 Rust 侧有真实文件系统访问权限。
 *
 * 注入前 path-safety 保持原字符串检查行为（不影响 dev 体验）。
 */
let defaultRealpathFn: RealpathFn | undefined;

export function setDefaultRealpathFn(fn: RealpathFn | undefined): void {
  defaultRealpathFn = fn;
}

export function getDefaultRealpathFn(): RealpathFn | undefined {
  return defaultRealpathFn;
}

/** 规范化路径：拆 / 与 \，处理 . 与 ..，不依赖 node path（浏览器环境也能跑） */
export function normalizePath(p: string): string {
  const isAbs = p.startsWith("/");
  const parts = p.split(/[/\\]+/);
  const stack: string[] = [];
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
      else if (!isAbs) stack.push("..");
      // 绝对路径下越过根的 .. 直接吞掉
    } else {
      stack.push(seg);
    }
  }
  return (isAbs ? "/" : "") + stack.join("/");
}

/** 把可能是相对的目标路径，按 workspace 解析成规范绝对路径 */
export function resolveInWorkspace(workspacePath: string, target: string): string {
  const ws = normalizePath(workspacePath);
  if (target.startsWith("/")) return normalizePath(target);
  return normalizePath(`${ws}/${target}`);
}

// 敏感路径模式（命中即拒绝读写）—— 实际正则已搬到 lib/security-invariants/sensitive-paths.ts（阶段 3 R7 集中）。
import { isSensitivePath as isSensitivePathCore } from "@/lib/security-invariants/sensitive-paths";

export const isSensitivePath = isSensitivePathCore;

export interface PathCheck {
  ok: boolean;
  resolved: string;
  reason?: string;
}

export interface PathCheckOptions {
  /**
   * 2.2 修复：realpath 函数注入。给定路径字符串，返回真实路径字符串（解析符号链接）。
   * - 不传：使用全局默认（应用启动时通过 setDefaultRealpathFn 注入）
   * - 传 null：明确禁用（不解析符号链接，保持原有字符串检查）
   * - 传函数：用该函数解析
   */
  realpathFn?: RealpathFn | null;
}

/**
 * 2.2 修复：ws 和 resolved 要么都解析、要么都不解析（保证形式一致）。
 *
 * 关键问题：macOS 上 `/var` 是符号链接，realpath 解析后变 `/private/var`。
 * 如果只解析 resolved 而不解析 ws，会出现"resolved 是 /private/var，ws 是 /var/...，前缀匹配失败"的假阳性。
 * 反过来如果只解析 ws 而不解析 resolved，会出现"resolved 落回 raw /var/...，ws 是 /private/var/...，前缀匹配失败"的假阴性。
 *
 * 解决方案：
 * - 没 fn → 都不解析（保持原字符串行为）
 * - resolved realpath 成功 → ws 也解析（保证两者都是 realpath 形式）
 * - resolved realpath 失败（路径不存在等） → ws 也保持 raw 形式（保证两者都是 raw 形式）
 *   这样"不存在的路径"被落回原路径后，比较逻辑正常工作，让下游 fs 操作报 ENOENT
 */
async function resolveBoth(
  wsRaw: string,
  initialResolved: string,
  options: PathCheckOptions | undefined,
): Promise<{ ws: string; resolved: string }> {
  const fn = options?.realpathFn === null
    ? undefined
    : options?.realpathFn ?? defaultRealpathFn;
  if (!fn) return { ws: wsRaw, resolved: initialResolved };

  let resolved: string;
  try {
    resolved = await fn(initialResolved);
  } catch {
    resolved = initialResolved;
  }

  let ws: string;
  if (resolved === initialResolved) {
    // resolved 没解析成功（抛错/reject fallback）→ ws 保持 raw 形式
    ws = wsRaw;
  } else {
    // resolved 解析成功 → ws 也解析（保证两者都是 realpath 形式）
    try {
      ws = await fn(wsRaw);
    } catch {
      ws = wsRaw;
    }
  }
  return { ws, resolved };
}

/**
 * 校验一个目标路径是否允许工具访问。
 * - 越出 workspace → 拒绝
 * - 命中敏感模式 → 拒绝
 *
 * 只读工具（glob/grep/read/git-read）用这个——保持"绝不越出工作区"的硬边界，
 * 免得模型瞎猜路径时到处乱翻，也避免只读操作也要弹确认框的摩擦。
 */
export async function checkPath(
  workspacePath: string,
  target: string,
  options: PathCheckOptions = {},
): Promise<PathCheck> {
  const wsRaw = normalizePath(workspacePath);
  const initialResolved = resolveInWorkspace(workspacePath, target);
  // 2.2 修复：ws 和 resolved 同步解析，保证形式一致（macOS /var 等差异也覆盖）
  const { ws, resolved } = await resolveBoth(wsRaw, initialResolved, options);

  if (resolved !== ws && !resolved.startsWith(ws + "/")) {
    return { ok: false, resolved, reason: `路径越出工作区边界：${resolved}` };
  }
  if (isSensitivePath(resolved)) {
    return { ok: false, resolved, reason: `拒绝访问敏感路径：${resolved}` };
  }
  return { ok: true, resolved };
}

export interface WritePathCheck {
  ok: boolean;
  resolved: string;
  reason?: string;
  /** 目标在工作区之外（敏感路径除外时仍然放行，但调用方要在确认弹窗里提醒用户这一点）。 */
  external: boolean;
}

/**
 * 写类工具（write/edit）专用的路径校验——比 checkPath 宽松一档：
 * 工作区外不再一律拒绝，而是标记 external:true 放行，让调用方在确认弹窗里多提醒一句
 * "这次要写到项目文件夹之外"，用户批准后才真正写入（跟 opencode 的 external_directory
 * 权限询问是同一个思路：不是不能碰工作区外，是碰之前要多问一句）。
 * 敏感路径（.ssh/.env 等）不管在不在工作区内，仍然一律硬拒绝——这条不因为"是写"就放松。
 */
export async function checkWritePath(
  workspacePath: string,
  target: string,
  options: PathCheckOptions = {},
): Promise<WritePathCheck> {
  const wsRaw = normalizePath(workspacePath);
  const initialResolved = resolveInWorkspace(workspacePath, target);
  // 2.2 修复：ws 和 resolved 同步解析（跟 checkPath 一致）
  const { ws, resolved } = await resolveBoth(wsRaw, initialResolved, options);

  if (isSensitivePath(resolved)) {
    return { ok: false, resolved, reason: `拒绝访问敏感路径：${resolved}`, external: false };
  }
  const external = resolved !== ws && !resolved.startsWith(ws + "/");
  return { ok: true, resolved, external };
}
