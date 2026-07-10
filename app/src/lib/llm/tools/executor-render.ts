import { truncateForContext, type ToolResultV2 } from "./result-contract";

export function renderResultForModel(result: ToolResultV2, maxOutputChars: number): string {
  const truncated = truncateForContext(result, maxOutputChars);
  const lines: string[] = [];
  lines.push(`[tool_status] ${truncated.status}`);
  lines.push(`[summary] ${truncated.summary}`);

  if (truncated.error) {
    lines.push(
      `[error_code] ${truncated.error.code}` +
        (truncated.error.retryable ? " (retryable=true)" : " (retryable=false)"),
    );
    lines.push(`[error_cause] ${truncated.error.rootCauseHint}`);
    if (truncated.error.retryInstruction) lines.push(`[error_retry_hint] ${truncated.error.retryInstruction}`);
    if (truncated.error.stopCondition) lines.push(`[error_stop_condition] ${truncated.error.stopCondition}`);
  }

  if (truncated.nextActions.length > 0) {
    const actions = truncated.nextActions
      .map((a) => `${a.action}${a.safe ? "" : " (需用户确认)"}: ${a.reason}`)
      .join(" | ");
    lines.push(`[next_actions] ${actions}`);
  }

  if (truncated.artifacts.length > 0) {
    const refs = truncated.artifacts
      .map((a) => `${a.kind}:${a.uri}${a.label ? ` (${a.label})` : ""}`)
      .join(" | ");
    lines.push(`[artifacts] ${refs}`);
  }

  lines.push("--- output ---");
  lines.push(truncated.output);
  return lines.join("\n");
}
