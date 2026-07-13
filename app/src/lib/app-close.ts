import { disposeLspSessions } from "@/lib/lsp/lsp-session";
import { disposeAllMcpSessions } from "@/lib/mcp/client";

export const CLOSE_CLEANUP_TIMEOUT_MS = 1_500;

interface CloseCleanupOptions {
  timeoutMs?: number;
  disposeLsp?: () => Promise<void>;
  disposeMcp?: () => Promise<void>;
}

export type CloseCleanupResult = "completed" | "timed_out";

// 修复（2026-07-13，真人复核指出的简化方向）：以前先查 hasBackgroundSessionsForClose()
// 判断"有没有后台会话"，没有才跳过清理——但这个判断本身就是一处额外的信号源，一旦判断
// 逻辑出错（真实事故：mcp/client.ts 的 hasKnownMcpSessions 曾把"模块加载过没有"错当成
// "现在是否有真实会话"，导致误判永远为 true）就会让每次关闭都白白变慢。清理本身在没有
// 真实会话时是空 Map，Promise.allSettled 近乎瞬间 resolve，没必要为了"跳过清理"专门维护
// 一套判断——直接无条件清理，靠这里的超时 + 调用方 Rust 侧看门狗兜底即可。

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
