// v0.7 阶段4 — 路径安全（工具读写的第一道防线）
//
// 规则（按 v2 方案的默认 deny 列表）：
//   1. 解析后的绝对路径必须在 workspace 之下（防路径遍历 ../../）
//   2. 默认拒绝敏感路径：.ssh / .aws / .gnupg / .env* / secrets.* / keystore.json
// 纯函数、不碰 fs，便于单测。实际 fs 读写由 tool 在通过本检查后再做。

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

// 敏感路径模式（命中即拒绝读写）
const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.env(\.|$|\/)/,
  /(^|\/)secrets?\.[^/]+$/i,
  /(^|\/)keystore\.json$/,
  /(^|\/)id_rsa(\.|$)/,
];

export function isSensitivePath(absPath: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(absPath));
}

export interface PathCheck {
  ok: boolean;
  resolved: string;
  reason?: string;
}

/**
 * 校验一个目标路径是否允许工具访问。
 * - 越出 workspace → 拒绝
 * - 命中敏感模式 → 拒绝
 *
 * 只读工具（glob/grep/read/git-read）用这个——保持"绝不越出工作区"的硬边界，
 * 免得模型瞎猜路径时到处乱翻，也避免只读操作也要弹确认框的摩擦。
 */
export function checkPath(workspacePath: string, target: string): PathCheck {
  const ws = normalizePath(workspacePath);
  const resolved = resolveInWorkspace(workspacePath, target);

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
export function checkWritePath(workspacePath: string, target: string): WritePathCheck {
  const ws = normalizePath(workspacePath);
  const resolved = resolveInWorkspace(workspacePath, target);

  if (isSensitivePath(resolved)) {
    return { ok: false, resolved, reason: `拒绝访问敏感路径：${resolved}`, external: false };
  }
  const external = resolved !== ws && !resolved.startsWith(ws + "/");
  return { ok: true, resolved, external };
}
