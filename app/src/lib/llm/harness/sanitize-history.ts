// Harness — 发送前清洗历史里的「文本假工具调用」，斩断弱模型的自我强化死循环。
//
// 病根（2026-07-17 用对照实验坐实）：MiniMax-M3 / GLM / Qwen 等模型只要在历史里看到过
// 一条「文本形态的工具调用」（如 <read_file><parameter name="path">…</read_file> 或
// <invoke name="read">…），下一轮就会照抄这个格式、当成正文吐出来，并且开始编造工具结果
// ——即使本轮 tools 是齐的、native tool_calls 完全可用（探针 A/C 干净历史→原生调用；探针 D
// 历史含一条文本假标签→立刻退化+编造）。
//
// 更糟的是我们自己的 harness 重试会把模型上一条的假标签原文当 assistant 消息塞回去
// （stream-runtime.ts 的重试回放），等于一边骂它编造、一边把样本递到它嘴边。
//
// 解决：在「消息发给模型前的最后一站」把历史 assistant 消息里的文本假工具调用清洗掉。
// 只清洗发给模型的副本——UI 显示 / 存库 / 防幻觉判定全部不受影响（用户照样看到「⚠️ 这条是编的」），
// 但模型的历史里没有可抄的样本，死循环从根上断掉。
//
// 与 detect-pseudo-tools.ts 的关系：那个是「判定违规 + UI 标黄」，只认死名单里的假工具名
// （run_command/view_file…）。这里是「发送前清洗」，必须更宽——要连 <read>/<read_file> 这种
// 「真工具名被当文本演出来」的情况一起清掉，所以额外认「含 <parameter name=…> 子标签的任意
// XML 块」这个最可靠的签名 + 本轮真实注册的工具名。

import { PSEUDO_TOOL_TAGS } from "./detect-pseudo-tools";

/** content 里的 text part 形态（只依赖结构，不引入 attachments 的运行时依赖）。 */
type TextPart = { type: "text"; text: string };
type ContentPart = TextPart | { type: string; [k: string]: unknown };

/** 整条 assistant 消息被清空后的中性占位——不声称任何工具真跑过、不含任何可模仿的格式。 */
export const STRIPPED_PLACEHOLDER = "（此前内容已省略）";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把一段文本里的「文本形态工具调用」清洗掉。对干净文本是恒等（返回同一字符串引用）。
 * @param text 原文
 * @param realToolNames 本轮真实注册的工具名（如 read/bash/grep/hashline_edit），用于连真名的
 *   <read>…</read> 一起清掉；不传则只靠 <parameter> 签名 + 死名单。
 */
export function stripPseudoToolText(text: string, realToolNames: readonly string[] = []): string {
  if (!text || (!text.includes("<") && !text.includes("{"))) return text;
  let out = text;

  // 1) <function_calls>…</function_calls> / <function_calls> 整块（Claude/antml 风格 wrapper，内含 invoke/parameter）
  out = out.replace(/<(?:antml:)?function_calls\b[\s\S]*?<\/(?:antml:)?function_calls>/gi, "");

  // 2) 含 <parameter name=…> 子标签的任意 XML 块——文本工具调用最可靠的签名。
  //    正常散文/代码几乎不可能出现 <parameter name=…>，所以按标签名通配安全。
  //    覆盖 <read_file>…<parameter…></read_file>、<invoke name="read">…<parameter…></invoke> 等。
  out = out.replace(
    /<(?:antml:)?([a-zA-Z][\w.:-]*)\b[^>]*>[\s\S]*?<(?:antml:)?parameter\b[\s\S]*?<\/(?:antml:)?\1>/gi,
    "",
  );

  // 3) 死名单里的假工具名 ∪ 本轮真实工具名——即使没有 <parameter> 子标签（如 <read>{"path":"x"}</read>
  //    或 <run_command>…</run_command>）也清掉。
  const namedTags = Array.from(
    new Set([...PSEUDO_TOOL_TAGS, ...realToolNames].map((s) => s.trim()).filter(Boolean)),
  ).map(escapeRegExp);
  if (namedTags.length > 0) {
    const namedTagRe = new RegExp(`<(${namedTags.join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "gi");
    out = out.replace(namedTagRe, "");
    // 截断流里没闭合的残留开标签（如 <read> 后面被停止键截断，没有 </read>）
    const danglingRe = new RegExp(`<(${namedTags.join("|")})\\b[^>]*>[\\s\\S]*$`, "gi");
    out = out.replace(danglingRe, "");
  }

  // 4) 残留的孤儿 <parameter name=…>…</parameter> 片段
  out = out.replace(/<(?:antml:)?parameter\b[^>]*>[\s\S]*?<\/(?:antml:)?parameter>/gi, "");

  // 5) 裸 JSON 式：{"name":"xxx","arguments":{…}}
  out = out.replace(/\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g, "");

  if (out === text) return text; // 未命中，保持引用恒等
  // 6) 清理：连续 3+ 空行折叠成 2 行
  return out.replace(/\n{3,}/g, "\n\n");
}

/**
 * 清洗一批消息里 assistant 角色的文本假工具调用。user/system 一律不动
 * （用户可能合法地粘贴 <read> 之类的 XML 来讨论，绝不能改用户输入）。
 * 对干净消息返回同一引用，对整批干净输入返回同一数组引用。
 */
export function sanitizePseudoToolHistory<
  T extends { role: string; content: string | ContentPart[] },
>(messages: readonly T[], realToolNames: readonly string[] = []): T[] {
  let anyChanged = false;
  const next = messages.map((m) => {
    if (m.role !== "assistant") return m;

    if (typeof m.content === "string") {
      const cleaned = stripPseudoToolText(m.content, realToolNames);
      if (cleaned === m.content) return m;
      anyChanged = true;
      const finalContent = cleaned.trim() === "" ? STRIPPED_PLACEHOLDER : cleaned;
      return { ...m, content: finalContent };
    }

    // 数组型 content：只清 text part，图片等原样保留
    let partChanged = false;
    const parts = m.content.map((p) => {
      if (p.type === "text" && typeof (p as TextPart).text === "string") {
        const cleaned = stripPseudoToolText((p as TextPart).text, realToolNames);
        if (cleaned !== (p as TextPart).text) {
          partChanged = true;
          return { ...p, text: cleaned };
        }
      }
      return p;
    });
    if (!partChanged) return m;
    anyChanged = true;
    return { ...m, content: parts };
  });
  return anyChanged ? next : (messages as T[]);
}
