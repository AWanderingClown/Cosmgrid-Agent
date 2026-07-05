// Harness — 提取模型「声称读取过」的文件路径，用于路径级真实性校验。
//
// 修订（2026-06-25）：原版提取正文所有路径片段（/app、/think、/Cosmgrid-Agent 等），
// 误报严重——模型正文提到路径 ≠ 声称读了该文件。改为**语境提取**：只在
// 「读取/查看/读了/打开」等动词后抓**带扩展名的文件路径**。
// 漏报优先于误报——误报会让用户不信 Harness（狼来了），漏报只是没抓到编。
//
// 伪工具调用 JSON 里的路径（<run_command>{"command":"cat X"}</run_command>）不在这抓——
// 那由 detect-pseudo-tools 负责抓伪工具标签本身，路径 claim 只管"声明读取"。
//
// 修订（2026-07-05，真实事故）：模型说"OKX.AI 接单注册流程（反推自 agent-commerce.js
// 真实代码）"——纯靠 grep 出的关键词脑补出一整套没读过的内容，完全没被这里抓到。两个漏洞：
// ① 动词表没有"反推自/挖到/抓到"这类"逆向分析出"的说法，只认"读取了"这类直接动词；
// ② 路径正则要求至少一段"目录/"前缀，bare 文件名（没有目录前缀的"agent-commerce.js"）
//   永远不可能匹配——现实里模型提到文件名时经常不带目录。都已修。

// 动词 + 带扩展名的文件路径（目录前缀可选，末段必须带扩展名，排除 /app /think 这种无扩展词）
const CLAIM_RE =
  /(?:读取了|读取|读过|读了|查看了|查看过|查看|看过|看了|已读|阅读了|阅读|打开了|打开|加载了|载入了|反推自|反推出|挖到|挖出|抓到|抓取到|扒出|提取自|提取出|拆解出|分析出|(?:I\s+)?(?:read|loaded|opened|viewed|checked|reverse[- ]engineered|extracted\s+from)(?:\s+(?:file|the\s+file))?)\s*[`'"\(\[]?\s*((?:[\/A-Za-z0-9._\-]+\/)*[A-Za-z0-9._\-]+\.[A-Za-z0-9]{1,8})/gi;

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
