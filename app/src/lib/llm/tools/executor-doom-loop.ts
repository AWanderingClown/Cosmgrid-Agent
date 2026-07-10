import {
  errorResult,
  TOOL_DOOM_LOOP,
  type ToolResultV2,
} from "./result-contract";
import { shapeOfInput } from "./executor-serialization";
import type { ToolContext } from "./types";

const DOOM_WINDOW = 8;
const DOOM_THRESHOLD = 3;
const DOOM_MAX_AGE_MS = 60_000;

interface DoomLoopEntry {
  toolName: string;
  inputJson: string;
  at: number;
}

const doomLoopByMessage = new Map<string, DoomLoopEntry[]>();
const doomLoopGlobal: DoomLoopEntry[] = [];

export function maybeBuildDoomLoopResult(
  ctx: ToolContext,
  toolName: string,
  rawInput: unknown,
  inputJson: string,
): ToolResultV2 | null {
  if (!detectAndTrackDoomLoop(ctx, toolName, inputJson)) return null;
  const inputShape = shapeOfInput(rawInput);
  return errorResult({
    output: `doom-loop 检测：工具 ${toolName} 在最近 ${DOOM_MAX_AGE_MS / 1000}s 内被以同样参数调用 ${DOOM_THRESHOLD} 次以上，禁止继续原样重试。请换策略或请求用户。`,
    summary: `doom-loop 拦截 ${toolName}`,
    error: {
      code: TOOL_DOOM_LOOP,
      rootCauseHint: `连续 ${DOOM_THRESHOLD}+ 次相同 (toolName, input) 调用：${toolName} ${inputShape}`,
      retryable: false,
      stopCondition:
        "禁止继续以同样参数调用 " +
        toolName +
        "；建议缩小输入范围 / 切工具 / 询问用户 / 拆分任务后再继续",
    },
    nextActions: [
      {
        action: "switch_strategy",
        reason: "同样参数已经失败多次，需要换思路（不同工具 / 拆分任务 / 询问用户）",
        safe: true,
      },
      {
        action: "ask_user",
        reason: "无法自主决策换什么策略时，请求用户提供方向",
        safe: true,
      },
    ],
  });
}

function detectAndTrackDoomLoop(ctx: ToolContext, toolName: string, inputJson: string): boolean {
  pruneEntries(doomLoopGlobal);
  if (ctx.messageId) {
    const list = doomLoopByMessage.get(ctx.messageId) ?? [];
    pruneEntries(list);
    doomLoopByMessage.set(ctx.messageId, list);
    if (isAboutToRepeat(list, toolName, inputJson, DOOM_THRESHOLD)) return true;
    trackEntry(list, toolName, inputJson);
    return false;
  }

  if (isAboutToRepeat(doomLoopGlobal, toolName, inputJson, DOOM_THRESHOLD)) return true;
  trackEntry(doomLoopGlobal, toolName, inputJson);
  return false;
}

function trackEntry(list: DoomLoopEntry[], toolName: string, inputJson: string): void {
  list.push({ toolName, inputJson, at: Date.now() });
  while (list.length > DOOM_WINDOW) list.shift();
}

function pruneEntries(entries: DoomLoopEntry[]): void {
  const cutoff = Date.now() - DOOM_MAX_AGE_MS;
  while (entries.length > 0 && entries[0]!.at < cutoff) entries.shift();
}

function isAboutToRepeat(list: DoomLoopEntry[], toolName: string, inputJson: string, threshold: number): boolean {
  if (list.length < threshold - 1) return false;
  const tail = list.slice(-(threshold - 1));
  return tail.every((e) => e.toolName === toolName && e.inputJson === inputJson);
}
