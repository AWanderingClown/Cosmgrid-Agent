// CLI 引擎协议层（纯逻辑，无 Tauri 依赖，可单测）
//
// 这是「spawn 官方 CLI 吃订阅额度」这条接入路径的核心。与 provider-factory（API 直连）
// 平行：API 直连按 token 付费、走 Vercel AI SDK；CLI 引擎 spawn 本机 `claude` / `codex`，
// 吃用户已买的订阅五小时额度，不按 token 付费。
//
// 关键设计（2026-06-21 实地验证 `claude -p` 跑通、确认吃订阅五小时额度）：
//   1. 污染隔离：cc switch 会往 ~/.claude/settings.json 的 env 字段塞 ANTHROPIC_BASE_URL
//      （指向 MiniMax）等，导致 spawn 出来的 claude 跑去第三方而非订阅。两道防线：
//      (a) 启动参数 `--setting-sources ""` 让 claude 忽略所有本地 settings 文件；
//      (b) 受控 env：把 ANTHROPIC_* / CLAUDE_CODE_* 污染变量从子进程环境里抹掉。
//   2. 输出是 JSONL（每行一个 JSON 对象），不是纯文本流。claude 与 codex 的事件结构不同，
//      各自一个解析器，归一化成统一的 CliStreamEvent。
//   3. claude 的 stream-json 里 `rate_limit_event` 带订阅额度剩余，未来可接 Token Plan 显示。

/** 支持的 CLI 引擎类型（对应 Provider.type） */
export const CLI_PROVIDER_TYPES = ["claude-cli", "codex-cli"] as const;
export type CliProviderType = (typeof CLI_PROVIDER_TYPES)[number];

/** 该 provider type 是否走 CLI 引擎（而非 provider-factory / streamText） */
export function isCliProviderType(type: string): type is CliProviderType {
  return (CLI_PROVIDER_TYPES as readonly string[]).includes(type);
}

/** 各 CLI 的默认可执行文件名（用户没填绝对路径时回退到 PATH 查找） */
export const CLI_DEFAULT_PROGRAM: Record<CliProviderType, string> = {
  "claude-cli": "claude",
  "codex-cli": "codex",
};

// ============ 受控环境变量 ============

/**
 * 必须从子进程环境里抹掉的变量：cc switch / Claude Code 注入这些会让 claude 改走第三方
 * 路由（如 MiniMax）或误判嵌套会话。抹掉后 claude 回落到订阅 OAuth 登录态。
 * 前缀匹配：任何以这些开头的 key 都清。
 */
export const POLLUTING_ENV_PREFIXES = [
  "ANTHROPIC_", // BASE_URL / AUTH_TOKEN / API_KEY / MODEL / DEFAULT_*_MODEL …
  "CLAUDECODE",
  "CLAUDE_CODE_",
  "CLAUDE_AGENT_SDK_",
] as const;

/**
 * 从父进程环境算出「要传给子进程的受控环境」。
 * 做法：拷贝父环境，删掉所有命中污染前缀的 key。返回新对象（不可变，不改入参）。
 */
export function buildControlledEnv(
  parentEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    const polluted = POLLUTING_ENV_PREFIXES.some((p) => key.startsWith(p));
    if (polluted) continue;
    out[key] = value;
  }
  return out;
}

// ============ 调用参数构造 ============

export interface CliMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * 把多轮对话历史拼成单个 prompt 文本传给 CLI（v1 策略）。
 * CLI 的 `-p` / `exec` 是单轮入口，跨进程 spawn 不持久 session，所以把整段历史
 * 序列化成文本带过去——限额自动换模型时同一份历史照样带，不丢上下文。
 */
export function buildPromptFromMessages(messages: readonly CliMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system") parts.push(`[System]\n${m.content}`);
    else if (m.role === "user") parts.push(`[User]\n${m.content}`);
    else parts.push(`[Assistant]\n${m.content}`);
  }
  return parts.join("\n\n");
}

/** 构造 spawn 用的参数（不含 program 本身） */
export function buildCliArgs(
  providerType: CliProviderType,
  modelName: string,
  prompt: string,
): string[] {
  if (providerType === "claude-cli") {
    // --output-format stream-json 需要配合 --verbose；--setting-sources "" 隔离被污染的本地配置
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--setting-sources",
      "",
    ];
    if (modelName.trim()) args.push("--model", modelName);
    return args;
  }
  // codex-cli：codex exec --json 输出 JSONL
  const args = ["exec", prompt, "--json"];
  if (modelName.trim()) args.push("--model", modelName);
  return args;
}

// ============ JSONL 输出解析 ============

/** 归一化后的流事件：上层只认这几种，不关心 claude / codex 的原始结构差异 */
export type CliStreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number }
  | { kind: "rate_limit"; resetsAt: number | null; limitType: string | null }
  | { kind: "error"; message: string }
  | { kind: "done"; finishReason: string };

interface ClaudeContentBlock {
  type: string;
  text?: string;
}

/**
 * 解析一行 claude stream-json。返回 0 或多个归一化事件（一行可能同时含文本和 usage）。
 * 容错：非 JSON 行 / 未知 type 一律返回空数组，不抛错（CLI 偶尔混入非 JSON 日志行）。
 */
export function parseClaudeStreamLine(line: string): CliStreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = obj["type"];
  const events: CliStreamEvent[] = [];

  if (type === "assistant") {
    const message = obj["message"] as { content?: ClaudeContentBlock[] } | undefined;
    const blocks = message?.content ?? [];
    for (const b of blocks) {
      if (b.type === "text" && typeof b.text === "string" && b.text) {
        events.push({ kind: "delta", text: b.text });
      }
    }
    return events;
  }

  if (type === "rate_limit_event") {
    const info = obj["rate_limit_info"] as
      | { resetsAt?: number; rateLimitType?: string }
      | undefined;
    events.push({
      kind: "rate_limit",
      resetsAt: typeof info?.resetsAt === "number" ? info.resetsAt : null,
      limitType: typeof info?.rateLimitType === "string" ? info.rateLimitType : null,
    });
    return events;
  }

  if (type === "result") {
    const isError = obj["is_error"] === true;
    if (isError) {
      const msg = typeof obj["result"] === "string" ? obj["result"] : "CLI returned an error";
      events.push({ kind: "error", message: msg });
      return events;
    }
    const usage = obj["usage"] as
      | { input_tokens?: number; output_tokens?: number }
      | undefined;
    events.push({
      kind: "usage",
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
    });
    const stopReason = typeof obj["stop_reason"] === "string" ? obj["stop_reason"] : "stop";
    events.push({ kind: "done", finishReason: stopReason });
    return events;
  }

  return events;
}

/**
 * 解析一行 codex --json。codex 的事件结构与 claude 不同（待 codex 套餐恢复后按实测细化）。
 * 当前按已知通用结构解析：item/message 文本增量 + token_count 用量。容错同上。
 */
export function parseCodexStreamLine(line: string): CliStreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = obj["type"];
  const events: CliStreamEvent[] = [];

  // codex 文本增量：常见为 { type: "item.completed"/"agent_message", text/delta }
  const text = (obj["delta"] ?? obj["text"]) as unknown;
  if (
    (type === "agent_message" || type === "item.completed" || type === "message") &&
    typeof text === "string" &&
    text
  ) {
    events.push({ kind: "delta", text });
  }

  if (type === "token_count" || type === "usage") {
    const usage = (obj["usage"] ?? obj) as { input_tokens?: number; output_tokens?: number };
    events.push({
      kind: "usage",
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    });
  }

  if (type === "error") {
    const msg = typeof obj["message"] === "string" ? obj["message"] : "codex returned an error";
    events.push({ kind: "error", message: msg });
  }

  if (type === "task_complete" || type === "turn.completed") {
    events.push({ kind: "done", finishReason: "stop" });
  }

  return events;
}

/** 按 provider 类型选对应解析器 */
export function parseCliStreamLine(
  providerType: CliProviderType,
  line: string,
): CliStreamEvent[] {
  return providerType === "claude-cli"
    ? parseClaudeStreamLine(line)
    : parseCodexStreamLine(line);
}
