import { disposeLspSessions } from "@/lib/lsp/lsp-session";
import { disposeAllMcpSessions } from "@/lib/mcp/client";

export const CLOSE_CLEANUP_TIMEOUT_MS = 1_500;

interface CloseCleanupOptions {
  timeoutMs?: number;
  disposeLsp?: () => Promise<void>;
  disposeMcp?: () => Promise<void>;
}

export type CloseCleanupResult = "completed" | "timed_out";

export async function disposeBackgroundSessionsForClose(
  options: CloseCleanupOptions = {},
): Promise<CloseCleanupResult> {
  const timeoutMs = options.timeoutMs ?? CLOSE_CLEANUP_TIMEOUT_MS;
  const disposeLsp = options.disposeLsp ?? disposeLspSessions;
  const disposeMcp = options.disposeMcp ?? disposeAllMcpSessions;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const cleanup = Promise.allSettled([disposeLsp(), disposeMcp()]).then((): CloseCleanupResult => "completed");
  const timeout = new Promise<CloseCleanupResult>((resolve) => {
    timeoutId = setTimeout(() => resolve("timed_out"), timeoutMs);
  });

  try {
    return await Promise.race([cleanup, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
