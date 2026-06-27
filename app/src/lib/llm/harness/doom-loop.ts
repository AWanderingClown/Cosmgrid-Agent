// Harness 阶段2 — Doom Loop 检测：连续 N 次相同工具调用（同名+同参）→ 判定死循环。
// 抄 OpenCode processor.ts:519-546（连续 3 次相同工具调用触发权限询问）。
// 在 streamText 的 onStepFinish 里累计 toolCalls，调这个纯函数判定，命中就 abort 流。

export interface StepToolCall {
  toolName: string;
  input: unknown;
}

/**
 * 检测连续 threshold 次相同的工具调用（同名 + 同参数 JSON）。
 * @param steps 累计的工具调用序列（按执行顺序）
 * @param threshold 连续多少次判定死循环，默认 3（抄 OpenCode）
 */
export function detectDoomLoop(steps: StepToolCall[], threshold = 3): boolean {
  if (steps.length < threshold) return false;
  const last = steps.slice(-threshold);
  const first = last[0]!;
  const firstInputJson = JSON.stringify(first.input);
  return last.every(
    (s) => s.toolName === first.toolName && JSON.stringify(s.input) === firstInputJson,
  );
}
