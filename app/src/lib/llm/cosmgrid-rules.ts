import cosmgridRules from "./CosmGrid.md?raw";

// CosmGrid 核心工作规则（“灵魂文件”）—— 产品给所有模型的统一系统提示。
//
// 一处定义，两路注入：
//   - API 模型：buildCorePreamble() 作为最前面的 system 消息（ChatPage outgoing）。
//   - CLI 引擎（claude/codex spawn）：COSMGRID_RULES 经 --append-system-prompt 注入
//     （因为 spawn 时 --setting-sources "" 屏蔽了本机 CLAUDE.md，必须我们显式塞）。
//
// 设计原则：系统提示本身就是给模型的“简洁”示范——所以这文件自己也保持精炼克制，
// 用短句和朴素结构，不堆装饰。措辞会直接影响所有模型的回复风格，改这里 = 改产品灵魂。

/** 纯规则正文（不含动态环境）。给 CLI --append-system-prompt 用。 */
export const COSMGRID_RULES = cosmgridRules.trim();

/**
 * 按二级标题摘取 CosmGrid.md 里的一段。单一信源：只从 COSMGRID_RULES 里切，
 * 不另外维护一份重复文本——避免"怎么说话"这类规则在别的调用点被复制一遍后各自漂移。
 */
function extractSection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === heading);
  if (startIdx === -1) return "";
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((l) => l.trim().startsWith("## "));
  const sectionLines = endIdx === -1 ? rest : rest.slice(0, endIdx);
  return [heading, ...sectionLines].join("\n").trim();
}

/**
 * 只含"怎么说话"这一段——给非主对话路径（如角色接力链）复用，
 * 让它们产出的内容跟主对话保持同一套语气，而不必整份注入用户/工具约定这些不相关的规则。
 */
export const COSMGRID_TONE_RULES = extractSection(COSMGRID_RULES, "## 怎么说话");

function detectOs(): string {
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    const ua = navigator.userAgent;
    if (/Mac/i.test(ua)) return "macOS";
    if (/Win/i.test(ua)) return "Windows";
    if (/Linux/i.test(ua)) return "Linux";
  }
  return "未知";
}

/**
 * 身份锚点：模型必须先知道"自己是谁、在哪运行"，再谈行为规则。
 * 不含身份陈述时，模型只看到一堆行为规则，答不出"你在什么软件里运行"这类问题。
 * @param driverLabel 当前驱动模型的人类可读名（如 "MiniMax-M3"、"Claude"），未知则省略这句
 */
export function buildIdentityLine(driverLabel?: string | null): string {
  const driver = driverLabel ? `，当前由 ${driverLabel} 驱动` : "";
  return `你是 Cosmgrid Agent 里的对话助手。Cosmgrid Agent 是一个桌面端 AI 编程/对话应用，支持多个模型供应商（Claude、Codex、MiniMax 等）自由切换${driver}。用户看到的界面是这个应用本身，不是模型厂商的官方客户端。`;
}

/**
 * 规则 + 动态环境，给 API 模型作为 system 消息。
 * @param workspacePath 当前工作文件夹（没绑则不带）
 * @param driverLabel 当前选中模型的人类可读名，随对话每轮切换实时更新
 */
export function buildCorePreamble(workspacePath?: string | null, driverLabel?: string | null): string {
  const env: string[] = [`系统：${detectOs()}`];
  if (workspacePath) env.push(`当前工作目录：${workspacePath}`);
  return `${buildIdentityLine(driverLabel)}\n\n${COSMGRID_RULES}\n\n## 环境\n${env.join("\n")}`;
}
