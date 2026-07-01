export function isNormalFinishReason(reason: string): boolean {
  return reason === "stop" || reason === "end_turn";
}

export function isRecoverableTruncation(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return normalized === "length" ||
    normalized === "max_tokens" ||
    normalized === "max_output_tokens" ||
    normalized === "output_limit" ||
    // AI SDK 的 stopWhen: stepCountIs(N) 撞到步数上限时，最后一步的 finishReason 就是
    // "tool-calls"（模型还想继续调工具，只是步数额度用完）——这是多步 agent 循环的正常中途状态，
    // 不是模型出错，应该续接重试，而不是当异常直接抛错炸掉整条链（曾导致多角色接力链
    // 在 QA/runner 等工具密集角色上硬失败："Model call ended abnormally: tool-calls"）。
    normalized === "tool-calls" ||
    normalized === "tool_calls";
}
