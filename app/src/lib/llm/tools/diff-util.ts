// v0.7 阶段4b — diff 计算（写操作前给用户看红绿对比）

import { diffLines } from "diff";

export interface DiffSummary {
  /** 统一 diff 文本（+ 增 / - 删 / 空格 不变） */
  patch: string;
  added: number;
  removed: number;
}

/** 计算两段文本的行级 diff，返回带 +/- 前缀的 patch 与增删行数 */
export function computeDiff(oldText: string, newText: string): DiffSummary {
  const parts = diffLines(oldText, newText);
  const out: string[] = [];
  let added = 0;
  let removed = 0;

  for (const part of parts) {
    const prefix = part.added ? "+" : part.removed ? "-" : " ";
    const lines = part.value.split("\n");
    // diff 的每段末尾常有空行，去掉末尾空串避免多一行
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      out.push(`${prefix}${line}`);
      if (part.added) added++;
      if (part.removed) removed++;
    }
  }

  return { patch: out.join("\n"), added, removed };
}

/** 人类可读的一句话摘要，如 "src/auth.ts（+12 −3）" */
export function diffSummaryLine(filePath: string, d: DiffSummary): string {
  return `${filePath}（+${d.added} −${d.removed}）`;
}
