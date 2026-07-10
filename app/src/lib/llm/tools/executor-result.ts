import { compatFromLegacy, type ToolResultV2 } from "./result-contract";
import type { ToolResult } from "./types";

export function normalizeToV2(result: ToolResult | ToolResultV2): ToolResultV2 {
  const candidate = result as ToolResultV2;
  if (Array.isArray(candidate.artifacts) && Array.isArray(candidate.nextActions)) {
    if (
      candidate.status === "success" ||
      candidate.status === "warning" ||
      candidate.status === "error" ||
      candidate.status === "denied" ||
      candidate.status === "timeout"
    ) {
      return candidate;
    }
  }
  return compatFromLegacy(result);
}
