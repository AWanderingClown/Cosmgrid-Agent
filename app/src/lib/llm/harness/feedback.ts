// Harness 阶段1 收尾——闭环的「反馈纠正」半步。
//
// 检测层（extract-claims / verify-claims / detect-pseudo-tools）只判定「模型编了」，
// 之前只事后标黄给用户看（违规→检测→提示用户）。本模块补上最后半步：
// 把违规组织成一条**回填给模型的纠正指令**，让它自查重答（违规→检测→反馈→纠正）。
//
// 设计取舍：
// - 纯函数，不碰 db / 不碰流式——只做「verdict → 纠正话术」与「verdict 是否干净」。
// - 重答封顶 1 次（调用方控制），避免模型反复造假烧 token。
// - 有工具 vs 没工具，纠正话术不同：没工具时不能叫它「去用真工具」（根本没有）。

import { extractFilePaths } from "./extract-claims";
import { verifyFileClaims, unverifiedClaims } from "./verify-claims";
import { detectPseudoToolCalls } from "./detect-pseudo-tools";
import { detectFabricatedUsageCount } from "./detect-usage-narration";
import type { ReadRecord } from "./verify-claims";

export interface HarnessVerdict {
  /** 模型声称读过、但 tool_executions 无对应 read 记录的文件路径 */
  unverifiedPaths: string[];
  /** 模型在正文里吐的伪工具名（run_command 等），未真实执行 */
  pseudoToolNames: string[];
  /** 模型声称的工具/命令使用次数超过本轮真实 toolCallCount——数字化的编造信号，无此类声称则为 null */
  fabricatedUsageCount?: number | null;
}

/**
 * 评估一条 assistant 回答：声称读的文件有没有真读、有没有吐伪工具调用、有没有编造使用次数。
 * 纯函数——readRecords 由调用方从 tool_executions 查好传进来；actualToolCallCount 默认 0
 * （不传时按"本轮没有真实工具调用"的最严格口径判定，向后兼容旧调用点）。
 */
export function evaluateHarness(
  content: string,
  readRecords: ReadRecord[],
  actualToolCallCount = 0,
): HarnessVerdict {
  const claimed = extractFilePaths(content);
  const unverifiedPaths = unverifiedClaims(verifyFileClaims(claimed, readRecords)).map((c) => c.claimed);
  const pseudoToolNames = [
    ...new Set(detectPseudoToolCalls(content).map((p) => p.toolName).filter((n): n is string => !!n)),
  ];
  const fabricatedUsageCount = detectFabricatedUsageCount(content, actualToolCallCount);
  return { unverifiedPaths, pseudoToolNames, fabricatedUsageCount };
}

/** verdict 是否干净（没检测到任何违规）。干净 = 不需要标黄、不需要重答。 */
export function isClean(v: HarnessVerdict): boolean {
  return v.unverifiedPaths.length === 0 && v.pseudoToolNames.length === 0 && !v.fabricatedUsageCount;
}

/**
 * 把违规组织成一条回填给模型的纠正指令（user 角色，作为下一轮输入）。
 * @param hasTools 本次对话模型是否挂了真工具——决定纠正方向（去用真工具 vs 纯文字/承认做不到）。
 * @returns 纠正话术；verdict 干净时返回空串（调用方应先判 isClean）。
 */
export function buildCorrectionPrompt(v: HarnessVerdict, opts: { hasTools: boolean }): string {
  if (isClean(v)) return "";
  const lines: string[] = ["⚠️ 系统自查发现你上一条回答可能在编造，未真实执行就声称做了。请纠正后重答："];

  if (v.unverifiedPaths.length > 0) {
    lines.push(
      `- 你声称读取过这些文件，但本次对话没有任何真实的 read 工具执行记录：${v.unverifiedPaths.join("、")}。`,
    );
    lines.push(
      opts.hasTools
        ? "  你有可用的 read 工具——请**真正调用 read 读取这些文件后**，根据真实内容重新回答；如果不需要读，就别声称读过。"
        : "  本次你没有可用的文件工具，无法真读文件。请**不要再编造文件内容**——直说你读不了，请用户把文件内容贴过来，或基于已知信息谨慎回答。",
    );
  }

  if (v.pseudoToolNames.length > 0) {
    lines.push(
      `- 你在正文里输出了伪工具调用文本（${v.pseudoToolNames.join("、")}），这些不是本应用的真工具，系统不会执行、其"返回结果"全是你脑补的。`,
    );
    lines.push(
      opts.hasTools
        ? "  请改用系统提供的标准工具调用（结构化 tool_call），不要在正文里写工具调用格式的文本。"
        : "  本次你没有任何可用工具。请**不要再输出任何工具调用格式的文本**，用纯文字回答，或直说这件事你做不了。",
    );
  }

  if (v.fabricatedUsageCount) {
    lines.push(
      `- 你在正文里声称跑了/用了 ${v.fabricatedUsageCount} 次工具或命令，但本轮真实的工具调用次数没有这么多——这段"执行过程"是编造的。`,
    );
    lines.push(
      "  请如实说明本轮实际做了什么：没有真实执行就不要报具体次数、编号、结果；如果这件事本来就做不到，直接说做不到。",
    );
  }

  lines.push("现在请重新回答用户最初的问题，遵守以上要求。");
  return lines.join("\n");
}

// ============ 阶段 H：Harness 兜底「说了要做却停下→自动催一次」 ============
//
// 病根：模型在正文里写"我先去看一下 foo.ts" / "让我打开 src 看看" / "我来处理这个 bug"，
// 但本轮 0 个真 tool_call——嘴上说要做，实际啥也没做。属于"懒人模式"。
//
// 跟现有 harness 违规（伪工具调用、未验证文件路径）的区别：
// - 现有违规：模型**假装**调了（吐伪工具 / 声称读过文件）
// - 本兜底：模型**承认**没调（明确说"我先去做"，但工具调用计数=0）
//
// 触发条件（调用方控制）：
//   finishReason="stop" + 绑了 tools + toolCallCount === 0 + detectIntentNoToolCall(content) === true
//
// 动作：回填 user 提示让同模型重答一次。封顶 1 次，**复用现有 MAX_HARNESS_RETRY 守门**（ChatPage 端 attempt 循环），
// 不叠加。
//
// 设计取舍：
// - 纯函数，不碰 db / 不碰流式
// - "漏报优于误报"（同 harness 总原则）：只匹配强信号（"我先/让我/我来/我们" + 明确动作动词），
//   不去模糊匹配 "我看看" / "我帮你看一下"（漏报没关系，触发多了会催烦）

/**
 * 检测"说了要做但没真做"：触发词 + 紧跟动作动词。
 * 命中 → true（建议触发 nudge 重答）。
 *
 * 触发的强信号（必须同时满足）：
 *   触发词：我先 | 让我(们)? | 我来 | 我们
 *   动作动词（紧跟在触发词后，可选"去"过渡）：看/读/处理/查/打开/改/写/跑/执行/做/弄/调/修复/删/添加/创建/新建
 *
 * 不触发的（漏报 OK，不误报）：
 *   "我先回答你的问题"（"回答"不是动作动词）
 *   "我建议你这样做"（无触发词）
 *   "答案是 X"（纯文字）
 *   "我看看"（无完整触发词）
 */
const INTENT_NO_TOOL_RE = /(我先|让我(?:们)?|我来|我们)\s*(?:去)?\s*(?:看|看看|读取?|处理|查(?:看)?|打开|改(?:写|变|一下)?|写(?:下)?|跑(?:一下)?|执行|做(?:一下)?|弄|调(?:整|试)?|修复|删(?:除)?|添加|创建|新建)/;

// 补（2026-07-04）：真实事故——模型说"好，再试一次。"/"再发一次"，不带"我先/让我"这类
// 前缀词，INTENT_NO_TOOL_RE 完全漏检，导致这句空手套白狼的话直接放行给用户，
// 下一轮模型还会照着这句瞎话去脑补"上一轮做了什么"（编出根本没发生过的错误细节）。
// 单独补一条"重试语气但没提到具体新动作"的信号——「再/重新」+「试/发/跑/请求/执行/来」+「一次/一遍」。
const RETRY_NO_TOOL_RE = /(再|重新)\s*(试|发|跑|请求|执行|来)\s*(一次|一遍)?/;

export function detectIntentNoToolCall(content: string): boolean {
  if (!content) return false;
  return INTENT_NO_TOOL_RE.test(content) || RETRY_NO_TOOL_RE.test(content);
}

/**
 * 构造 nudge user 提示（让同模型重答一次，**不复用 buildCorrectionPrompt**，话术不同：
 * buildCorrectionPrompt 是"你编了"的口径；nudge 是"你嘴上说要做但没做"的口径）。
 */
export function buildIntentNudgePrompt(): string {
  return [
    "⚠️ 你上一条回答说要去做某事（用了「我先 / 让我 / 我来」之类的措辞），但本轮没有任何真实的工具调用记录。",
    "请直接调用系统提供的工具完成你说的操作——别再只描述意图。",
    "如果你说的事情本来就不需要工具（例如纯文字解释），请改用完成时态直接陈述结果，不要用「我先去看看 / 让我打开 / 我来处理」这类未执行的措辞。",
  ].join("\n");
}
