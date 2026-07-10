// chat-fallback 的公共类型 + toModelEndpoint 构造器，从 chat-fallback.ts 拆出（2026-07-09）。
// 拆分原因：chat-fallback.ts 原本 719 行，是"东西堆一起"的热点文件之一，这部分是纯类型定义
// + 一个无副作用的构造函数，跟 streamWithFallback 主循环没有实现耦合，独立成文件不影响任何调用方
// ——chat-fallback.ts 继续从这里 re-export，所有现有消费者的 import 路径和符号完全不变。

import type { ToolSet } from "ai";
import type { LlmErrorCategory } from "./error-classifier";
import type { CliAccessOptions } from "./cli-protocol";
import type { ModelEndpoint, StreamUsage } from "./chat-fallback-contracts";
import type { LlmInvocationAuditEvent } from "./invocation-audit";
export type { ModelEndpoint, StreamUsage } from "./chat-fallback-contracts";

/**
 * 切模型的原因（discriminated union）
 * - kind="error"：主模型真出错（带 LlmErrorCategory 分类）
 * - kind="cooldown"：主模型在 cooldown 中熔断，UI 提示"X 秒后可重试"
 * 不再用 LlmErrorCategory 一把抓，避免 cooldown 被假报成 rate_limit。
 */
export type SwitchReason =
  | { kind: "error"; category: LlmErrorCategory }
  | { kind: "cooldown" }
  | { kind: "recovery"; reason: string };

/** 流式过程的回调钩子 */
export interface StreamCallbacks {
  /** 每收到一段文本增量时触发（流式输出靠这个） */
  onDelta: (delta: string) => void;
  /**
   * 切换到下一个模型时触发（仅切的时候调一次，不切不调）。
   * 第一次进入时也会调：如果 models[0] 在 cooldown 中直接跳到 models[1]，会先调一次。
   */
  onSwitched?: (from: ModelEndpoint, to: ModelEndpoint, reason: SwitchReason) => void;
  /**
   * 整段对话成功结束时触发，UI 拿这个落 UsageEvent（chat-fallback 已自动调过 recordUsageEvent，
   * 这里给 UI 用于刷新"上次调用消耗"显示 + 自定义逻辑）。
   * interrupted=true 表示用户主动 abort（不写 usage，标记 interrupted）。
   */
  onUsage?: (usage: StreamUsage, model: ModelEndpoint, finishReason: string, interrupted: boolean) => void;
  /**
   * 系统自动恢复的方式：原生续跑 / 上下文重放 / fallback 接力
   * detail：修复（2026-07-07，用户实测发现）——native_resume 之前只在 UI 上显示一句
   * 静态"系统已用 CLI 官方会话原生续跑"，触发它的真实原因（首次调用失败的错误文本）
   * 只打进 devtools 控制台，不懂开发者工具的用户完全看不到、只能来回问。这里把原始
   * 失败原因带出来，UI 直接拼进同一条提示里，不需要用户会用任何调试工具。
   */
  onRecovered?: (mode: "native_resume" | "context_replay" | "fallback_handoff", detail?: string) => void;
  /** CLI/agent 中间状态，不计入最终回答正文 */
  onStatus?: (status: string) => void;
  /** CLI 官方输出的实际模型名，例如 sonnet 别名会解析成 claude-sonnet-4-6 */
  onResolvedModel?: (modelName: string, target: ModelEndpoint) => void;
  /**
   * streamText 全部 step 跑完后，把累积的所有 toolCalls 一次交给 caller。
   * 不传=noop，零侵入。Abort 中断时不调。
   */
  onFinalToolCalls?: (toolCalls: { toolName: string; input?: unknown }[]) => void;
  /** L1 接入层审计事实：每次模型调用成功/失败/冷却/中断都以统一形态吐出。 */
  onInvocationAudit?: (event: LlmInvocationAuditEvent) => void;
}

/** `streamWithFallback` 的选项——同时是单次 `runModelAttempt` 需要的调用上下文子集来源。 */
export interface StreamWithFallbackOptions {
  signal?: AbortSignal;
  /** 关联 projectId（用于 UsageEvent 落库），自由对话不传 */
  projectId?: string;
  /** 关联 conversationId（也用于 CLI session 持久化关联） */
  conversationId?: string;
  /** 消息难度桶（simple/standard/hard），落 UsageEvent 供 v0.9 SmartRouter 滚动统计。
   *  不传则内部按最后一条 user 消息推断（调用方无需各自重复算）。 */
  role?: string;
  /** 阶段 F1：actor 维度（leader/architect/frontend/.../stage）。
   *  - 跟 role（workRole 难度桶）配对清晰，不撞名
   *  - 不传 → NULL（review F1-1：leader 占比 80%+，NULL 是真实数据，聚合不过滤）
   *  - 调用方责任：必须显式传（ChatPage 主对话 → 'leader'，ProjectDetailPage → 'stage'，runChain 每跳 → role: RoleId） */
  actorRole?: string | null;
  /** v0.7 阶段4：工具集（read/glob/grep 等）。传了才开启工具调用 + 多步 agentic 循环 */
  tools?: ToolSet;
  /** 工具调用最大步数（防死循环），默认 8 */
  maxToolSteps?: number;
  /** 强制本轮必须真调用工具（"required"）。用于 harness nudge 重答——模型上一次
   *  嘴上说了要做却 0 工具调用，文字提醒不够硬，直接在 API 层锁死它这次必须调用，
   *  不给它继续嘴炮的选项。不传 = "auto"（照常自行判断）。 */
  toolChoice?: "auto" | "required";
  /** CLI 引擎（claude/codex）的权限档位 + 放行目录。只在 primaryIsCli 时有意义——
   *  翻译成 --sandbox/--permission-mode/--add-dir，让 app 的"只读/确认写/自动"真正管到
   *  CLI 子进程（否则 CLI 只能写工作区内，用户"保存到桌面"被 CLI 自己的沙箱拒绝）。 */
  cliAccess?: CliAccessOptions;
  /** 单次回答的最大输出 token。不传则用 DEFAULT_MAX_OUTPUT_TOKENS。
   *  关键：很多 OpenAI 兼容端点（MiniMax 等）不传 max_tokens 时默认值很小，
   *  推理型模型会把预算花在 <think> 上、正文没写完就被截断 → 必须显式给足。 */
  maxOutputTokens?: number;
  routingDecision?: {
    baselineModelId: string;
    baselineModelName: string;
    baselineProviderType?: string | null;
    actualModelId: string;
  } | null;
  compressionStats?: {
    beforeTokens: number;
    afterTokens: number;
  } | null;
}

/**
 * 从 DB 形态 + 凭证 + apiKey 构造 ModelEndpoint。
 * 把"模型缺 provider 类型"的检查集中到一处——原来 4 个调用点都重复做这个 guard。
 */
export function toModelEndpoint(
  model: {
    id: string;
    name: string;
    displayName: string | null;
    providerId: string;
    provider?: { type: string } | null;
  },
  credential: { id: string; baseUrl: string },
  apiKey: string,
): ModelEndpoint {
  const providerType = model.provider?.type;
  if (!providerType) {
    throw new Error("Model missing provider type — re-add the provider");
  }
  return {
    modelId: model.id,
    modelName: model.name,
    providerType,
    providerId: model.providerId,
    apiCredentialId: credential.id,
    apiKey,
    baseUrl: credential.baseUrl,
    displayLabel: model.displayName ?? model.name,
  };
}
