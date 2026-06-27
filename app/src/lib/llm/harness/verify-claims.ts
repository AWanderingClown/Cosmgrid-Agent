// Harness 阶段1 — 比对「模型声称读过的路径」vs「tool_executions 里真有 read 记录的路径」。
//
// 真实性校验的核心：模型说看了 X，但 tool_executions 里没有对应 read X 的执行记录
// → 模型在编（没真读）。路径级比对，不做内容匹配（模型会 paraphrase）。
//
// read 记录从 tool_executions 表查：input 字段是 JSON.stringify({file_path, ...})。

export interface ReadRecord {
  /** tool_executions.input，JSON 字符串，read 工具的形如 {file_path,...} */
  input: string;
  /** status：success/denied/error，denied/error 也算「尝试过但没读到」→ 仍算 verified=false（没真读到内容） */
  status: string;
}

export interface ClaimVerification {
  claimed: string;
  verified: boolean;
  /** 没读到的原因（用于 UI 提示） */
  reason?: string;
}

/** 从一条 read 审计记录的 input 里解析出 file_path */
function extractReadPath(input: string): string | null {
  try {
    const obj = JSON.parse(input) as unknown;
    if (obj && typeof obj === "object" && "file_path" in obj) {
      const fp = (obj as { file_path: unknown }).file_path;
      if (typeof fp === "string" && fp) return fp;
    }
  } catch {
    // 坏 JSON 忽略
  }
  return null;
}

/** 路径匹配：处理相对/绝对、basename 同名等情形 */
function pathMatches(claimed: string, actual: string): boolean {
  const c = claimed.replace(/\/+$/, "");
  const a = actual.replace(/\/+$/, "");
  if (c === a) return true;
  // 一方是另一方的后缀（相对路径 vs 绝对路径）
  if (c.endsWith("/" + a) || a.endsWith("/" + c)) return true;
  if (c.endsWith(a) || a.endsWith(c)) return true;
  // basename 相同且是文件（含扩展名）—— 慎用，要求带扩展名避免目录误命中
  const cb = c.split("/").pop();
  const ab = a.split("/").pop();
  if (cb && ab && cb === ab && /\.\w+$/.test(cb)) return true;
  return false;
}

/**
 * 校验模型声称的路径列表。
 * @param claimedPaths 模型文本里提取的路径（extractFilePaths 的输出）
 * @param readRecords 本次对话 tool_executions 里所有 read 工具的审计记录
 * @returns 每条 claimed 是否被真实 read 过
 */
export function verifyFileClaims(
  claimedPaths: string[],
  readRecords: ReadRecord[],
): ClaimVerification[] {
  // 只认 status=success 的 read（denied/error 没真读到内容，不能算模型「看过」的依据）
  const readPaths = readRecords
    .filter((r) => r.status === "success")
    .map((r) => extractReadPath(r.input))
    .filter((p): p is string => p !== null);

  return claimedPaths.map((claimed) => {
    const matched = readPaths.some((rp) => pathMatches(claimed, rp));
    return matched
      ? { claimed, verified: true }
      : { claimed, verified: false, reason: "模型引用了此文件，但本次对话没有对应的 read 工具执行记录——内容可能是编造的" };
  });
}

/** 便捷：返回所有未通过校验的路径（UI 标红用） */
export function unverifiedClaims(claims: ClaimVerification[]): ClaimVerification[] {
  return claims.filter((c) => !c.verified);
}
