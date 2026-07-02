/** 把模型正文切成「可折叠块（思考 / 工具调用 / 博弈过程）」和「正文」。
 *  很多模型会把非正文内容直接吐在 content 里，不切出来就刷屏：
 *  - 推理过程：<think>…</think> / 限流…<thinking>（agnes / MiniMax / GLM 等）
 *  - 假工具调用：{"name":"run_command","arguments":{…}} 这类裸 JSON 文本
 *    （模型不走结构化 tool_calls、凭训练记忆在正文里"演" agent 循环，吐的工具名
 *    如 run_command/view_file/update_plan 往往根本不是本应用真有的工具——纯垃圾文本）
 *  - 多模型对弈过程：<debate_process>…</debate_process>（debate-result.ts 主动包裹，
 *    见坑.md用户反馈——博弈的中间产物 solver/critic/judge 完整输出不该平铺刷屏，
 *    默认折叠，只有"最终判断"直接展示）
 *  这些都折叠成一行可点的小字，正文照常显示。流式时未闭合的 think 块视为"进行中"。 */

// 伪工具标签名单复用 harness/detect-pseudo-tools（单一来源：检测什么就折叠什么，加标签只改一处）
import { PSEUDO_TOOL_TAGS } from "@/lib/llm/harness/detect-pseudo-tools";

export type SegmentType = "think" | "tool" | "debate" | "text";
export type ContentSegment = { type: SegmentType; content: string; closed: boolean };

// 思考类标签
const THINK_TAGS = ["think", "thinking"] as const;
// 博弈过程标签（debate-result.ts 主动包裹，不是模型自己吐的）
const DEBATE_TAGS = ["debate_process"] as const;

// 标签名（小写）→ 折叠块类型。思考标签 → think；所有伪工具标签 → tool；博弈过程 → debate。
const COLLAPSE_TAGS: Record<string, "think" | "tool" | "debate"> = {
  think: "think",
  thinking: "think",
  debate_process: "debate",
};
for (const t of PSEUDO_TOOL_TAGS) COLLAPSE_TAGS[t] = "tool";

// 阶段一：按 <think>/<thinking>/<tool_call> 等标签切成 think / tool / text 粗段
function splitByThinkingTags(text: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  // 开/闭标签成对匹配，覆盖思考 + 伪工具调用 + 博弈过程三类。\b[^>]* 兼容 <run_command foo="x"> 带属性
  const tagRe = new RegExp(
    `<(\\/?)(${[...THINK_TAGS, ...PSEUDO_TOOL_TAGS, ...DEBATE_TAGS].join("|")})\\b[^>]*>`,
    "gi",
  );
  let cursor = 0;
  let depth = 0;
  let blockStart = 0;
  let blockType: "think" | "tool" | "debate" = "think";
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) {
    const isClose = m[1] === "/";
    const kind = COLLAPSE_TAGS[m[2]!.toLowerCase()]!;
    if (!isClose) {
      if (depth === 0) {
        // 进入折叠块前的正文
        if (m.index > cursor) {
          segments.push({ type: "text", content: text.slice(cursor, m.index), closed: true });
        }
        blockStart = m.index + m[0].length;
        blockType = kind;
      }
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) {
        segments.push({ type: blockType, content: text.slice(blockStart, m.index), closed: true });
        cursor = m.index + m[0].length;
      }
    }
  }
  if (depth > 0) {
    // 流式中：块还没闭合，剩下的全归这个块
    segments.push({ type: blockType, content: text.slice(blockStart), closed: false });
  } else if (cursor < text.length) {
    segments.push({ type: "text", content: text.slice(cursor), closed: true });
  }
  return segments;
}

// 假工具调用 JSON 的起始哨兵：{"name": "..."（允许 { 与 "name" 间有空格）
// 用正则而不是固定字符串，兼容 {"name": / { "name" : 等空格变体。
const TOOL_CALL_START_RE = /\{\s*"name"\s*:\s*"/g;

/** 阶段二：把 text 段里裸 JSON 工具调用切成 tool 段。
 *  模型不走结构化 tool_calls 时会把 {"name":"run_command",...} 直接吐在正文里，且往往
 *  吐残缺（漏 }、夹零碎标签）。这里按 {"name": 哨兵位置切——哨兵之间（含）全是 tool
 *  碎片折叠掉，哨兵之前的正文保留。不依赖 JSON 是否合法闭合，残缺也照样折叠。 */
function splitToolJson(text: string): ContentSegment[] {
  const starts: number[] = [];
  TOOL_CALL_START_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOOL_CALL_START_RE.exec(text)) !== null) starts.push(m.index);
  if (starts.length === 0) {
    return text ? [{ type: "text", content: text, closed: true }] : [];
  }
  const segs: ContentSegment[] = [];
  let cursor = 0;
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    // 哨兵之前的正文保留
    if (start > cursor) segs.push({ type: "text", content: text.slice(cursor, start), closed: true });
    // 到下一个哨兵（或到结尾）之间全是 tool 碎片
    const end = i + 1 < starts.length ? starts[i + 1] : text.length;
    segs.push({ type: "tool", content: text.slice(start, end), closed: true });
    cursor = end;
  }
  return segs;
}

function mergeAdjacentCollapsedSegments(segments: ContentSegment[]): ContentSegment[] {
  const merged: ContentSegment[] = [];
  let pendingWhitespace: ContentSegment | null = null;

  for (const seg of segments) {
    if (seg.type === "text" && seg.content.trim() === "") {
      pendingWhitespace = seg;
      continue;
    }

    const last = merged[merged.length - 1];
    if (last?.type === "think" && seg.type === "think") {
      const gap = pendingWhitespace?.content ?? "";
      last.content = `${last.content}${gap}${seg.content}`;
      last.closed = last.closed && seg.closed;
      pendingWhitespace = null;
      continue;
    }

    if (pendingWhitespace) {
      merged.push(pendingWhitespace);
      pendingWhitespace = null;
    }
    merged.push(seg);
  }

  if (pendingWhitespace) merged.push(pendingWhitespace);
  return merged;
}

export function parseThinking(text: string): ContentSegment[] {
  // 先按标签切粗段，再把 text 粗段里的裸 JSON 工具调用切出来
  const raw = splitByThinkingTags(text);
  const out: ContentSegment[] = [];
  for (const seg of raw) {
    if (seg.type === "text") {
      out.push(...splitToolJson(seg.content));
    } else {
      out.push(seg);
    }
  }
  return mergeAdjacentCollapsedSegments(out);
}
