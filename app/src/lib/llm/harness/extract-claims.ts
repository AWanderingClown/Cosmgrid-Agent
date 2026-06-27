// Harness — 提取模型「声称读取过」的文件路径，用于路径级真实性校验。
//
// 修订（2026-06-25）：原版提取正文所有路径片段（/app、/think、/Cosmgrid-Agent 等），
// 误报严重——模型正文提到路径 ≠ 声称读了该文件。改为**语境提取**：只在
// 「读取/查看/读了/打开」等动词后抓**带扩展名的文件路径**。
// 漏报优先于误报——误报会让用户不信 Harness（狼来了），漏报只是没抓到编。
//
// 伪工具调用 JSON 里的路径（<run_command>{"command":"cat X"}</run_command>）不在这抓——
// 那由 detect-pseudo-tools 负责抓伪工具标签本身，路径 claim 只管"声明读取"。

// 动词 + 带扩展名的文件路径（至少一段 / + 末段带扩展，排除 /app /think 这种单段无扩展）
const CLAIM_RE =
  /(?:读取了|读取|读过|读了|查看了|查看过|查看|看过|看了|已读|阅读了|阅读|打开了|打开|加载了|载入了|(?:I\s+)?(?:read|loaded|opened|viewed|checked)(?:\s+(?:file|the\s+file))?)\s*[`'"\(\[]?\s*((?:[\/A-Za-z0-9._\-]+\/)+[A-Za-z0-9._\-]+\.[A-Za-z0-9]{1,8})/gi;

/**
 * 从 assistant 文本提取模型「声明读取过」的文件路径（语境提取，非所有路径）。
 * @returns 去重后的路径数组
 */
export function extractFilePaths(text: string): string[] {
  const cleaned = text.replace(/https?:\/\/[^\s"'<>)\]]+/gi, ""); // 先删 URL，避免误抓
  const found = new Set<string>();
  for (const m of cleaned.matchAll(CLAIM_RE)) {
    const p = m[1];
    if (p && !p.startsWith("//")) found.add(p);
  }
  return [...found];
}
