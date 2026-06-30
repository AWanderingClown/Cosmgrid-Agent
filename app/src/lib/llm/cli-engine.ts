// CLI 引擎 spawn 层（依赖 Tauri，运行时才生效）
//
// 把 cli-protocol（纯逻辑）和 Rust 的 spawn_cli_stream 命令接起来：
//   构造参数 → invoke Rust spawn → Channel 流式收 stdout 行 → 协议层解析 → 回调。
// 与 provider-factory + streamText（API 直连）平行，由 chat-fallback 按 provider 类型分流。

import { Channel, invoke } from "@tauri-apps/api/core";
import {
  buildCliArgs,
  buildCliResumeArgs,
  buildPromptFromMessages,
  parseCliStreamLine,
  CLI_DEFAULT_PROGRAM,
  type CliProviderType,
  type CliMessage,
} from "./cli-protocol";
import { COSMGRID_RULES } from "./cosmgrid-rules";

/** Rust spawn_cli_stream 通过 Channel 推回的原始事件（与 lib.rs 的 CliStreamEvent 对应） */
type RustCliEvent =
  | { type: "stdout"; line: string }
  | { type: "stderr"; line: string }
  | { type: "terminated"; code: number | null }
  | { type: "error"; message: string };

export interface CliEndpoint {
  providerType: CliProviderType;
  /** 模型别名/全名（传 --model） */
  modelName: string;
  /** CLI 可执行文件绝对路径；空则回退到 PATH 查找默认名 */
  program?: string;
  /** CLI 子进程工作目录；绑定工作文件夹时必须传，避免读到 Cosmgrid-Agent 自身 */
  workingDirectory?: string | null;
}

export interface CliStreamCallbacks {
  onDelta: (text: string) => void;
  onStatus?: (text: string) => void;
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  /** 订阅额度状态（claude 的 rate_limit_event），用于未来接 Token Plan 显示 */
  onRateLimit?: (info: { resetsAt: number | null; limitType: string | null }) => void;
  onSession?: (officialSessionId: string) => void;
  onModel?: (modelName: string) => void;
}

export interface CliStreamResult {
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  officialSessionId: string | null;
  actualModelName: string | null;
}

/** 给本次 spawn 生成唯一 id，Rust 端据此存 child 句柄、abort 时按 id kill。 */
function newCliSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `cli-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * spawn 本机 CLI 流式对话。成功 resolve usage；CLI 报错（未登录 / 额度耗尽 / 非零退出）reject。
 * abort：前端停止接收并 resolve（finishReason="abort"），同时 invoke kill_cli 真正 SIGKILL
 *   子进程——否则 CLI 仍在后台跑完，白耗订阅额度。
 */
export async function streamViaCli(
  endpoint: CliEndpoint,
  messages: readonly CliMessage[],
  callbacks: CliStreamCallbacks,
  options: { signal?: AbortSignal; resumeSessionId?: string | null; resumePrompt?: string } = {},
): Promise<CliStreamResult> {
  const program = endpoint.program?.trim() || CLI_DEFAULT_PROGRAM[endpoint.providerType];
  const prompt = buildPromptFromMessages(messages);
  const args = options.resumeSessionId
    ? buildCliResumeArgs(
        endpoint.providerType,
        endpoint.modelName,
        options.resumeSessionId,
        options.resumePrompt ?? prompt,
        COSMGRID_RULES,
      )
    : buildCliArgs(endpoint.providerType, endpoint.modelName, prompt, COSMGRID_RULES);
  const sessionId = newCliSessionId();

  let usage = { inputTokens: 0, outputTokens: 0 };
  let finishReason = "stop";
  let errorMsg: string | null = null;
  let stderrBuf = "";
  let officialSessionId: string | null = options.resumeSessionId ?? null;
  let actualModelName: string | null = null;

  return new Promise<CliStreamResult>((resolve, reject) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (errorMsg) {
        const err = new Error(errorMsg) as Error & { officialSessionId?: string | null };
        err.officialSessionId = officialSessionId;
        reject(err);
      } else resolve({ ...usage, finishReason, officialSessionId, actualModelName });
    };

    const channel = new Channel<RustCliEvent>();
    channel.onmessage = (ev) => {
      if (settled) return;
      switch (ev.type) {
        case "stdout": {
          // 一次回调可能含多行（Rust 按行 trim 但保险再按 \n 拆）
          for (const line of ev.line.split("\n")) {
            for (const e of parseCliStreamLine(endpoint.providerType, line)) {
              if (e.kind === "delta") callbacks.onDelta(e.text);
              else if (e.kind === "status") callbacks.onStatus?.(e.text);
              else if (e.kind === "usage") {
                usage = { inputTokens: e.inputTokens, outputTokens: e.outputTokens };
                callbacks.onUsage?.(usage);
              } else if (e.kind === "session") {
                officialSessionId = e.sessionId;
                callbacks.onSession?.(e.sessionId);
              } else if (e.kind === "model") {
                actualModelName = e.modelName;
                callbacks.onModel?.(e.modelName);
              } else if (e.kind === "rate_limit") {
                callbacks.onRateLimit?.({ resetsAt: e.resetsAt, limitType: e.limitType });
              } else if (e.kind === "error") {
                errorMsg = e.message;
              } else if (e.kind === "done") {
                finishReason = e.finishReason;
              }
            }
          }
          break;
        }
        case "stderr":
          stderrBuf += `${ev.line}\n`;
          break;
        case "error":
          errorMsg = ev.message;
          break;
        case "terminated":
          if (!errorMsg && ev.code !== 0 && ev.code !== null) {
            errorMsg = stderrBuf.trim() || `CLI exited with code ${ev.code}`;
          }
          settle();
          break;
      }
    };

    // abort：前端立即收尾恢复 UI，并请 Rust 真正杀掉子进程（停止白耗额度）。
    // kill_cli 失败不影响前端收尾——进程可能已自然结束，只记日志不阻塞。
    options.signal?.addEventListener("abort", () => {
      if (settled) return;
      settled = true;
      void invoke("kill_cli", { sessionId }).catch((err: unknown) => {
        console.warn("kill_cli 失败（子进程可能已结束）：", err);
      });
      resolve({ ...usage, finishReason: "abort", officialSessionId, actualModelName });
    });

    invoke("spawn_cli_stream", {
      sessionId,
      program,
      args,
      extraEnv: {},
      workingDirectory: endpoint.workingDirectory ?? null,
      onEvent: channel,
    }).catch((err: unknown) => {
      if (settled) return;
      errorMsg = err instanceof Error ? err.message : String(err);
      settle();
    });
  });
}
