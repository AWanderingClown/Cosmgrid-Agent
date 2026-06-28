export function isNormalFinishReason(reason: string): boolean {
  return reason === "stop" || reason === "end_turn";
}

export function isRecoverableTruncation(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return normalized === "length" ||
    normalized === "max_tokens" ||
    normalized === "max_output_tokens" ||
    normalized === "output_limit";
}
