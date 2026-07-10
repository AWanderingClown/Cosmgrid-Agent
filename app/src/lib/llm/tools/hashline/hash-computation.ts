// 移植自 hashline-core/src/hash-computation.ts。
// 只保留单行计算 + 整段格式化——原版还有 streamHashLinesFromUtf8/streamHashLinesFromLines
// 两个分块流式生成器，是给"边读边吐 chunk"的场景用的；我们的 read-tool 本来就是
// 一次性读完整个文件再按 offset/limit 切片，不需要那层分块，故不搬（保持精简）。

import { HASHLINE_DICT } from "./constants";
import { hashXxh32 } from "./xxhash32";

const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

function computeNormalizedLineHash(lineNumber: number, normalizedContent: string): string {
  const stripped = normalizedContent;
  // 空行/纯符号行没有"有意义字符"可算，用行号当 seed 防止大量空行互相撞 hash。
  const seed = RE_SIGNIFICANT.test(stripped) ? 0 : lineNumber;
  const hash = hashXxh32(stripped, seed);
  const index = hash % 256;
  return HASHLINE_DICT[index]!;
}

/** 当前行 hash：去掉行尾空白后算，容忍模型自己加的尾随空格差异。 */
export function computeLineHash(lineNumber: number, content: string): string {
  return computeNormalizedLineHash(lineNumber, content.replace(/\r/g, "").trimEnd());
}

/** 旧版兼容 hash：去掉所有空白后算——用于 validateLineRefs 兼容历史引用格式。 */
export function computeLegacyLineHash(lineNumber: number, content: string): string {
  return computeNormalizedLineHash(lineNumber, content.replace(/\r/g, "").replace(/\s+/g, ""));
}

export function formatHashLine(lineNumber: number, content: string): string {
  const hash = computeLineHash(lineNumber, content);
  return `${lineNumber}#${hash}|${content}`;
}

export function formatHashLines(content: string): string {
  if (!content) return "";
  const lines = content.split("\n");
  return lines.map((line, index) => formatHashLine(index + 1, line)).join("\n");
}
