// 给模型的「当前时间小抄」——每次发送只塞一条 system 消息，省 token。
//
// 为什么需要：大模型脑子里没有时钟，直接问"今天几号"它只能瞎猜。
// 解决办法是发消息时在最前面悄悄塞一条带真实时间的 system 消息（用户界面不显示），
// 模型读这条就能答对日期、算"明天/这周五/距月底几天"等所有时间相关问题。
// 跟 Claude Code 程序给 Claude 喂 "Today's date is ..." 是同一个做法。

import type { ProjectMemory } from "@/lib/db";

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * 构造「当前时间」system 小抄。用本机时区，不联网。
 * @param now 当前时间，默认 new Date()（传参便于测试）
 */
export function buildTimePreamble(now: Date = new Date()): string {
  const y = now.getFullYear();
  const mo = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const wd = WEEKDAYS[now.getDay()];
  return `当前时间：${y}-${mo}-${d} ${wd} ${h}:${mi}（用户本地时区）。回答与日期或时间相关的问题时以此为准，不要凭空猜测。`;
}

/**
 * 构造「无工具可用」system 小抄。仅在没给模型挂工具时塞（没绑工作区 + 非 CLI 引擎）。
 *
 * 为什么需要：MiniMax-M3 等模型在请求里没带 tools 时，会"幻觉式"地在 content 正文里
 * "演"一整套工具调用循环——吐 <run_command>{"command":"..."}</run_command>、
 * <view_file>、<update_plan> 等它训练语料里别的 agent 框架的工具调用文本，直接刷屏。
 * （实测：绑了工作区→传 tools→M3 返回标准 tool_calls 走真执行；没绑→不传 tools→M3 演文本。）
 *
 * 解决：没 tools 时明确告诉模型"你没有工具，纯文字回答，别输出工具调用格式"。
 * 实测（curl 直打 M3）能彻底压住演工具冲动，模型改用纯文字说明"我做不了，你把内容贴过来"。
 * CLI 引擎（claude/codex spawn）自带工具，不走这条；绑了工作区的正常工具路径也不走这条。
 */
export function buildNoToolsPreamble(): string {
  return [
    "你当前没有接入任何工具或函数（没有文件读取、命令执行、代码搜索等能力）。",
    "请直接用纯文字回答用户。",
    "禁止输出任何工具调用格式的文本，包括但不限于：<run_command>、<view_file>、<update_plan>、<tool>、{\"name\":\"...\",\"arguments\":...} 等标签或 JSON。",
    "无法完成的事直接用文字说明原因，不要假装调用工具、不要输出工具调用的伪代码。",
    "如果用户的需求明显需要读写文件、跑命令、查代码这类能力，除了说明现在做不到，还必须主动告诉用户：点输入框下方的「选择文件夹」绑定一个工作目录，绑定后这些能力就会开启——不要只列限制、不给出路。",
  ].join("");
}

/**
 * 阶段 H：图片/二进制文件守卫 preamble。绑了工作区 + 有工具时塞到 system prompt 开头。
 *
 * 病根：模型看到 .png/.jpg/.pdf 等二进制文件路径，**会先 read 试图当文本读**——read 工具返回乱码，
 * 模型拿乱码继续编造"看到 X 是 Y"，产生幻觉。要改图/缩放/转换格式时本来该用 sips(macOS) / ImageMagick。
 *
 * 规则：
 *  - 图片/二进制文件**不能**当文本 read
 *  - 要改图（缩放/裁剪/转格式）→ 直接 bash 跑 sips（macOS 原生）或 ImageMagick（convert / magick）
 *  - 要查看图片元信息 → bash `sips -g all foo.png` 或 `identify foo.png`
 *  - 想看图内容（图像理解）→ 用支持 vision 的模型传图，**别先 read 图片路径**
 */
export function buildImageGuardPreamble(): string {
  return [
    "图片/二进制文件（.png/.jpg/.jpeg/.gif/.webp/.pdf/.zip/.tar 等）**不能**当文本读取——read 工具会返回乱码。",
    "改图（缩放/裁剪/旋转/转格式）→ 直接 bash 跑 sips（macOS 原生，例如 `sips -Z 800 foo.png`）或 ImageMagick（`convert foo.png -resize 800x bar.png`）。",
    "看图片元信息 → bash `sips -g all foo.png`（macOS）或 `identify foo.png`（ImageMagick）。",
    "理解图像内容（图像描述/OCR 等）→ 用支持 vision 的模型传图，**别先 read 图片路径**。",
  ].join("\n");
}

// 修订（2026-07-07）：查 opencode 源码（技术参考/opencode-dev/packages/opencode/src/session/
// system.ts:25）发现它按 model.api.id 分了 8 套系统提示，只有 kimi.txt 一份里明确写了
// "Try your best to avoid any hallucination. Do fact checking..."——其余 7 份（含 anthropic/
// gpt/gemini）都没有这句。说明连成熟的多模型 harness 也认为国产模型需要更直白的反编造提醒，
// 不是靠一份通用提示词能覆盖的。CosmGrid.md 是所有模型共用的核心提示，不适合把这段只对
// 部分模型有效的话塞进去——照 opencode 的思路单独判 driverLabel，命中才加。
const DOMESTIC_MODEL_KEYWORDS = ["minimax", "kimi", "moonshot", "glm", "智谱", "qwen", "通义", "deepseek"];

/** driverLabel（如 "MiniMax-M3"）是否匹配已知国产模型家族，命中才需要额外反编造提醒 */
function isDomesticModel(driverLabel: string): boolean {
  const lower = driverLabel.toLowerCase();
  return DOMESTIC_MODEL_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * 国产模型专属反编造提醒。不传或不匹配已知国产模型家族时返回 null（不占 token）。
 * @param driverLabel 当前驱动模型的人类可读名，如 "MiniMax-M3"
 */
export function buildDomesticModelReminder(driverLabel: string | null | undefined): string | null {
  if (!driverLabel || !isDomesticModel(driverLabel)) return null;
  return [
    "额外提醒：你没有真正调用工具、没有拿到真实执行结果时，绝对不要在正文里描述",
    "「我看到/我读到/我运行了……」这类话，也不要把「在回复里写出代码」当成「已经把代码写进文件」。",
    "拿不到真实结果就直接说做不到、请用户提供内容，不要用听起来合理的内容填空。",
  ].join("");
}

function shorten(text: string, max = 120): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/**
 * 构造「当前项目记忆」system 小抄。只喂当前项目，避免把别的项目背景混进来。
 * 用途：让模型在真实对话里继承项目决策/约束，而不是把记忆只当成"侧边栏档案"。
 */
export function buildProjectMemoryPreamble(
  projectName: string | null | undefined,
  memories: Pick<ProjectMemory, "kind" | "title" | "content" | "tags" | "importance">[],
): string | null {
  if (memories.length === 0) return null;
  const header = projectName?.trim()
    ? `当前项目记忆（项目：${projectName.trim()}）`
    : "当前项目记忆";
  const lines = memories.slice(0, 6).map((m, idx) => {
    const tags = m.tags?.trim() ? `；标签：${shorten(m.tags, 40)}` : "";
    return `${idx + 1}. [${m.kind}｜重要度 ${m.importance}] ${shorten(m.title, 36)}：${shorten(m.content, 140)}${tags}`;
  });
  return [
    `${header}：以下内容只代表当前项目，回答时优先遵守；不要把其他项目的经验混进来，除非用户明确要求跨项目借鉴。`,
    ...lines,
  ].join("\n");
}

/**
 * 构造「跨项目参考」system 小抄。它不是当前项目事实，只是其他项目的可借鉴经验。
 */
export function buildCrossProjectMemoryPreamble(
  memories: Pick<ProjectMemory, "projectName" | "kind" | "title" | "content" | "importance">[],
): string | null {
  if (memories.length === 0) return null;
  const lines = memories.slice(0, 3).map((m, idx) => {
    const project = m.projectName?.trim() || "未命名项目";
    return `${idx + 1}. [${project}｜${m.kind}｜重要度 ${m.importance}] ${shorten(m.title, 36)}：${shorten(m.content, 120)}`;
  });
  return [
    "以下内容来自其他项目，仅作借鉴，不代表当前项目事实；若与当前项目记忆、当前代码或当前工作区冲突，以当前项目为准。",
    ...lines,
  ].join("\n");
}
