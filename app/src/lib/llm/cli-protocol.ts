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
const CLI_PROVIDER_TYPES = ["claude-cli", "codex-cli"] as const;
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
const POLLUTING_ENV_PREFIXES = [
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

/** 构造 spawn 用的参数（不含 program 本身）。
 *  systemPrompt：CosmGrid 核心规则，经 claude 的 --append-system-prompt 正式注入——
 *  因为 --setting-sources "" 屏蔽了本机 CLAUDE.md，必须我们显式塞，CLI 才受同一套约束。 */
export function buildCliArgs(
  providerType: CliProviderType,
  modelName: string,
  prompt: string,
  systemPrompt?: string,
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
    if (systemPrompt?.trim()) args.push("--append-system-prompt", systemPrompt);
    if (modelName.trim()) args.push("--model", modelName);
    return args;
  }
  // codex-cli：codex exec --json 输出 JSONL（codex 无 --append-system-prompt，规则随 prompt 文本带过去）
  const args = ["exec", prompt, "--json"];
  if (modelName.trim()) args.push("--model", modelName);
  return args;
}

export function buildCliResumeArgs(
  providerType: CliProviderType,
  modelName: string,
  officialSessionId: string,
  prompt: string,
  systemPrompt?: string,
): string[] {
  if (providerType === "claude-cli") {
    const args = [
      "--resume",
      officialSessionId,
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--setting-sources",
      "",
    ];
    if (systemPrompt?.trim()) args.push("--append-system-prompt", systemPrompt);
    if (modelName.trim()) args.push("--model", modelName);
    return args;
  }
  const args = ["exec", "resume", officialSessionId, prompt, "--json"];
  if (modelName.trim()) args.push("--model", modelName);
  return args;
}

export type CliResumeCapability =
  | { mode: "stateless"; reason: string }
  | { mode: "resumable"; sessionId: string; resumeArgs: string[] };

// ============ JSONL 输出解析 ============

/** 归一化后的流事件：上层只认这几种，不关心 claude / codex 的原始结构差异 */
export type CliStreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "status"; text: string }
  | { kind: "model"; modelName: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number }
  | { kind: "rate_limit"; resetsAt: number | null; limitType: string | null }
  | { kind: "session"; sessionId: string }
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

  if (type === "system" && obj["subtype"] === "init" && typeof obj["session_id"] === "string") {
    events.push({ kind: "session", sessionId: obj["session_id"] });
    if (typeof obj["model"] === "string" && obj["model"]) {
      events.push({ kind: "model", modelName: obj["model"] });
    }
    return events;
  }

  if (type === "assistant") {
    const message = obj["message"] as { content?: ClaudeContentBlock[]; model?: string } | undefined;
    // Claude CLI 在鉴权失败时会先吐一条 model="<synthetic>" 的 assistant 文本，
    // 随后才在 result 事件里标 is_error=true。这里不能把那条合成文本当成正常回复。
    if (typeof obj["error"] === "string" || message?.model === "<synthetic>") return [];
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

  if (type === "thread.started" && typeof obj["thread_id"] === "string") {
    events.push({ kind: "session", sessionId: obj["thread_id"] });
    return events;
  }

  const item = obj["item"] as Record<string, unknown> | undefined;

  // codex 文本增量：
  // - 旧格式：{ type: "agent_message", text: "..." }
  // - 当前实测：{ type: "item.completed", item: { type: "agent_message", text: "..." } }
  const text = (item?.["text"] ?? item?.["delta"] ?? obj["delta"] ?? obj["text"]) as unknown;
  const itemType = item?.["type"];
  if (
    (type === "agent_message" || type === "item.completed" || type === "message") &&
    (type !== "item.completed" || itemType === undefined || itemType === "agent_message") &&
    typeof text === "string" &&
    text
  ) {
    events.push({ kind: "delta", text });
  }

  if (type === "token_count" || type === "usage" || type === "turn.completed") {
    const usage = (obj["usage"] ?? obj) as { input_tokens?: number; output_tokens?: number };
    if (typeof usage.input_tokens === "number" || typeof usage.output_tokens === "number") {
      events.push({
        kind: "usage",
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
      });
    }
  }

  if (type === "item.started" && itemType === "mcp_tool_call") {
    const server = typeof item?.["server"] === "string" ? item.server : "tool";
    const tool = typeof item?.["tool"] === "string" ? item.tool : "call";
    events.push({ kind: "status", text: `正在调用 ${server}.${tool}...` });
  }

  if (type === "item.completed" && itemType === "mcp_tool_call") {
    const status = item?.["status"];
    if (status === "failed") {
      const error = item?.["error"] as { message?: string } | null | undefined;
      const message = typeof error?.message === "string" ? error.message : "工具调用失败";
      events.push({ kind: "status", text: `工具调用失败：${message}` });
    }
  }

  if (type === "error") {
    const rawMessage = obj["message"];
    const msg = typeof rawMessage === "string" ? rawMessage : "codex returned an error";
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

export function extractOfficialSessionId(
  providerType: CliProviderType,
  line: string,
): string | null {
  const sessionEvent = parseCliStreamLine(providerType, line).find((event) => event.kind === "session");
  return sessionEvent?.kind === "session" ? sessionEvent.sessionId : null;
}

export function detectCliResumeCapability(args: {
  providerType: CliProviderType;
  modelName: string;
  officialSessionId: string | null;
}): CliResumeCapability {
  if (!args.officialSessionId) {
    return { mode: "stateless", reason: "CLI output did not expose a stable official session id" };
  }
  return {
    mode: "resumable",
    sessionId: args.officialSessionId,
    resumeArgs: buildCliResumeArgs(
      args.providerType,
      args.modelName,
      args.officialSessionId,
      "Continue from where you stopped. Do not repeat completed content.",
    ),
  };
}
