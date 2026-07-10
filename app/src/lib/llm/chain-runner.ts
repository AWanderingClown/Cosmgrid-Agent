// 阶段 E2a — watch 图真·多角色接力执行器
//
// E1 只算链条顺序（computeChain），E2 让 chain 跑起来——每个接力角色真调一次模型，
// 工件+摘要链式传递，进度回调可观测，一键中止（复用 abortRef）。
//
// 守关键铁律（用户 2026-06-26 拍板）：
//  1. **tools 必传**：每跳调 streamWithFallback 时把 buildAiSdkTools(工作区 + 权限档) 透传，
//     chain 角色能真干活（read/write/edit/bash）—— 否则重演 M3 "想干活没工具" bug
//  2. **leader 不重复**：chain 已过滤 leader（E1 的 computeChain）。主对话那一跳 = leader，
//     chain 接力从 architect 起，不重复响应
//  3. **nudge 套进 chain 每跳**：复用 H 阶段的 detectIntentNoToolCall + buildIntentNudgePrompt，
//     chain 内每个角色接力也守"光说不做 → 催一次"闭环（封顶 1 次，复用 MAX_HARNESS_RETRY）
//  4. **成本封顶**：复用 E1 的 MAX_CHAIN_LENGTH = 3
//  5. **ChainContext 精简**：每跳 prompt 只装"用户原始任务 + 上一角色摘要 + 工件标题"，不传完整历史
//  6. **ChainContext 纯函数**：buildChainContext / buildChainMessages / pickChainRoleModel 都纯函数，
//     单测覆盖，不依赖 UI 状态
//
// 设计取舍：
//  - 复用 streamWithFallback（chat-fallback 不动），不另造执行引擎
//  - executor 已自动落 tool_executions 审计（阶段 0），产出物面板（work-artifacts）有数据
//  - 不动 orchestrator.ts / chat-fallback.ts / harness/* —— chain-runner 是新独立模块
//  - E2a 范围：纯逻辑 + ChatPage 集成层；UI 整理（进度条 + 中止按钮 + i18n）留 E2b

import { streamWithFallback, type ModelEndpoint, type StreamUsage, type SwitchReason } from "./chat-fallback";
import { COSMGRID_TONE_RULES } from "./prompts/cosmgrid-rules";
import { pickBestModelWithPerformance } from "./model-performance-scoring";
import { ROLE_IDS, ROLE_LABELS, ROLE_TO_WORK_ROLE, type RoleId } from "./orchestrator";
import {
  detectIntentNoToolCall,
  buildIntentNudgePrompt,
  buildCorrectionPrompt,
  isClean,
  type HarnessVerdict,
} from "./harness/feedback";
import type { LanguageModel } from "./provider-factory";
import type { ChatMsg } from "./context-compressor";

/** ChainContext — 接力上下文，纯函数派生。E2a 内部用，E2b 也可能用 */
export interface ChainContext {
  /** 用户的原始任务（首条 user message） */
  userTask: string;
  /** 已接力角色的产出摘要（按顺序，最多 MAX_CHAIN_LENGTH 个） */
  previousOutputs: { role: RoleId; summary: string }[];
  /** 已接力角色的工件标题列表（从 tool_executions 派生；省 token，只传标题不传全文） */
  previousArtifactTitles: { role: RoleId; titles: string[] }[];
}

/** 单次执行的工具调用次数记上限——复用 H 阶段 MAX_HARNESS_RETRY=1。
 *  chat-fallback 的 streamWithFallback 内已有 maxRetries=3（API 重试），跟这个独立。 */
const MAX_HARNESS_RETRY = 1;

/** ChainContext 摘要截断上限——避免接力越接越长 */
const SUMMARY_MAX_CHARS = 500;

/** 工件标题列表截断上限——每个角色最多传 20 个标题 */
const ARTIFACT_TITLES_MAX = 20;

/**
 * 阶段 E2a 纯函数：从已接力角色 + 工件派生 ChainContext。
 * 不依赖消息流、不依赖 UI，纯数据 → 纯数据，可单测。
 *
 * @param args.userTask 用户原始任务（首条 user message 内容）
 * @param args.executedRoles 已接力角色的产出（按顺序，role + 完整 content）
 * @param args.roleArtifacts 角色 → 工件标题列表（可选；E2a 从 messages 里 extract，E2b 可接 tool_executions 派生）
 */
export function buildChainContext(args: {
  userTask: string;
  executedRoles: { role: RoleId; content: string }[];
  roleArtifacts?: Record<RoleId, string[]>;
}): ChainContext {
  return {
    userTask: args.userTask,
    previousOutputs: args.executedRoles.map((r) => ({
      role: r.role,
      // 摘要截断到 SUMMARY_MAX_CHARS，省 token
      summary: r.content.length > SUMMARY_MAX_CHARS
        ? r.content.slice(0, SUMMARY_MAX_CHARS) + "…"
        : r.content,
    })),
    previousArtifactTitles: args.roleArtifacts
      ? Object.entries(args.roleArtifacts)
          .filter(([, titles]) => titles.length > 0)
          .map(([role, titles]) => ({
            role: role as RoleId,
            titles: titles.slice(0, ARTIFACT_TITLES_MAX),
          }))
      : [],
  };
}

/**
 * 阶段 E2a 纯函数：构造该跳角色的 messages 输入。
 *  - 1 条 system 消息：角色任务 + ChainContext（链上下文）
 *  - 1 条 user 消息：用户原始任务
 *  - **不传完整对话历史**——每跳 prompt 是干净的"接力上下文 + 用户任务"
 *
 * @param role 该跳角色
 * @param userTask 用户原始任务
 * @param ctx 已接力 ChainContext
 * @param hasTools 本跳是否有真工具（决定 system prompt 文案）
 */
export function buildChainMessages(
  role: RoleId,
  userTask: string,
  ctx: ChainContext,
  hasTools: boolean,
): ChatMsg[] {
  const roleLabel = ROLE_LABELS[role];
  const sysLines: string[] = [
    // 接力角色的产出直接展示给用户，语气要跟主对话一致（不奉承、不堆格式、中文作答等）
    ...(COSMGRID_TONE_RULES ? [COSMGRID_TONE_RULES] : []),
    `你正在「角色团队接力」中扮演：${roleLabel}（角色 key=${role}）。`,
    `用户原始任务：${userTask}`,
    `请基于已接力角色的产出（如下），完成你的部分。`,
  ];

  if (ctx.previousOutputs.length > 0) {
    sysLines.push("\n## 已接力角色的产出（按顺序）");
    for (const o of ctx.previousOutputs) {
      sysLines.push(`### ${ROLE_LABELS[o.role]}（${o.role}）\n${o.summary}`);
    }
  }

  if (ctx.previousArtifactTitles.length > 0) {
    sysLines.push("\n## 已产出的工件标题（你不需要重做这些）");
    for (const a of ctx.previousArtifactTitles) {
      sysLines.push(`- ${ROLE_LABELS[a.role]}: ${a.titles.join("、")}`);
    }
  }

  if (hasTools) {
    sysLines.push(
      "\n你有真实工具可用（read / write / edit / bash / glob / grep 等）。要操作时**直接调用工具**，不要只描述意图。",
    );
    sysLines.push(
      "如果用户原始任务里没有明确要求你做的事（如架构师只出方案 / 执行者只跑 build），做你该做的部分就停手——接力链上下一个角色会继续。",
    );
  } else {
    sysLines.push("\n本次你没有可用工具。如需文件操作，请直说让用户配合。");
  }

  return [
    { role: "system", content: sysLines.join("\n") },
    { role: "user", content: userTask },
  ];
}

/**
 * 阶段 E2a 纯函数：给该跳角色选模型。
 * 优先级：① D 阶段 roleBindings（用户模板里配的）→ ② pickBestModelWithPerformance 按 ROLE_TO_WORK_ROLE 选最合适的
 *
 * @param role 该跳角色
 * @param bindings D 阶段的角色绑定（D 已落库，ChatPage 编排前查好传入）
 * @param endpoints 可用模型端点（chat-fallback 的 ModelEndpoint 列表）
 * @returns 选中的端点；没模型可用返 null（ChatPage 跳过该跳）
 */
export function pickChainRoleModel(
  role: RoleId,
  bindings: Map<RoleId, string>,
  endpoints: ModelEndpoint[],
): ModelEndpoint | null {
  if (endpoints.length === 0) return null;

  // L1: 绑定优先
  const bindingId = bindings.get(role);
  if (bindingId) {
    const bound = endpoints.find((e) => e.modelId === bindingId);
    if (bound) return bound;
  }

  // L2: fallback 按 ROLE_TO_WORK_ROLE 自动选
  const candidates = endpoints.map((e) => ({
    id: e.modelId,
    name: e.modelName,
    capabilityScore: null,
    workRoles: "[]", // ModelEndpoint 没 workRoles 字段（那是 Model 表的字段）；用名字查静态分
  }));
  const best = pickBestModelWithPerformance(ROLE_TO_WORK_ROLE[role], candidates);
  if (best) {
    const found = endpoints.find((e) => e.modelId === best.id);
    if (found) return found;
  }

  // L3: 兜底取第一个
  return endpoints[0]!;
}

// ============ runChain 主函数 ============

/** runChain 的回调接口——E2a 给最简版，E2b 接完整 UI（进度条/中止按钮/i18n） */
export interface ChainCallbacks {
  /** 接力开始（idx=0） */
  onChainStart?: (total: number) => void;
  /** 每跳角色开始执行 */
  onRoleStart?: (role: RoleId, idx: number, total: number) => void;
  /** 每跳角色流式增量（deltas 是该角色产出，UI 累积显示） */
  onRoleDelta?: (role: RoleId, delta: string) => void;
  /** 每跳角色完成（含 nudge 重答后） */
  onRoleDone?: (role: RoleId, idx: number, total: number, content: string) => void;
  /** 整条链完成 */
  onChainDone?: (executedRoles: { role: RoleId; content: string }[]) => void;
  /** 任意一跳的 usage 信息透传（给 UI 显示累计 token） */
  onUsage?: (usage: StreamUsage, model: ModelEndpoint, finishReason: string) => void;
  /** 模型切换透传 */
  onSwitched?: (from: ModelEndpoint, to: ModelEndpoint, reason: SwitchReason) => void;
}

export interface ChainHarnessCheckArgs {
  role: RoleId;
  content: string;
  attempt: number;
  hasTools: boolean;
  startedAt: string;
  finishReason: string;
  toolCallCount: number;
  /**
   * 当前跳的 assistant message id（可选）。useChatStream 在 onRoleStart 时为每跳造 id，
   * 透传给 harnessCheck 让 fabrication judge 按 messageId 优先归属工具证据。
   * 未传 → fallback 到 sinceIso 时间窗口（兜底，不污染已有真实归属的新行）。
   */
  assistantMessageId?: string | null;
  /**
   * fabrication 语义裁判用的辅助模型（可选）。复用 useChatStream 的 intentJudgeModel；
   * 未传 → 跳过语义裁判，只走现有硬校验路径（不阻断正常回答，只是少了第二层防护）。
   */
  judgeModel?: LanguageModel | null;
}

export interface ChainArgs {
  /** E1 computeChain 输出——已过滤 leader 的接力链（最多 MAX_CHAIN_LENGTH 个） */
  chain: RoleId[];
  /** 用户原始任务（首条 user message） */
  userTask: string;
  /** 用于 abortSignal（复用 ChatPage 已有的 controller） */
  controller: AbortController;
  /** D 阶段 roleBindings（resolveOrchestration 也用的同一份） */
  bindings: Map<RoleId, string>;
  /** 可用模型端点（streamWithFallback 的 ModelEndpoint 列表） */
  models: ModelEndpoint[];
  /** ★ 必传：buildAiSdkTools(registry, ctx) 出来的 tools，含权限档 + confirm 回调 */
  tools: ReturnType<typeof import("./tools").buildAiSdkTools> | undefined;
  /** 当前会话 ID（写 UsageEvent / tool_executions 关联用） */
  conversationId: string | null;
  /** 当前 project ID（可选，UsageEvent / tool_executions 关联） */
  projectId?: string | null;
  /**
   * 当前跳的 assistant message id（每跳 onRoleStart 时刷新，由 runChainImpl 内部维护并
   * 透传给 harnessCheck）。让 fabrication judge 能按 messageId 优先归属工具证据。
   * 留作可选——外部 harnessCheck 也可以走 closure 自取（兼容旧调用点）。
   */
  getCurrentMessageId?: () => string | null;
  /**
   * fabrication 语义裁判用的辅助模型——与主对话 evalHarnessForConversation 共用同一入口。
   * 命名由调用方负责转换（useChatStream 把 prep.intentJudgeModel 映射到 judgeModel）。
   */
  judgeModel?: LanguageModel | null;
  /** E2a DI：测试时注入 fake streamWithFallback，避开 vi.fn() 异步 mock 拿 callbacks 的坑 */
  _deps?: { streamWithFallback?: typeof streamWithFallback };
  /** 阶段 S2：每跳回答完成后的 Harness 校验（按该跳开始时间做证据窗口过滤）。 */
  harnessCheck?: (args: ChainHarnessCheckArgs) => Promise<HarnessVerdict | null>;
  /** 回调 */
  callbacks?: ChainCallbacks;
}

export interface ChainResult {
  /** 用户中止的位置（null = 完整跑完） */
  stoppedAt: RoleId | null;
  /** 已接力的角色产出 */
  executedRoles: { role: RoleId; content: string }[];
  /** 跳过的角色（无模型可用） */
  skippedRoles: RoleId[];
  /** 最终仍未通过 Harness 的角色（重答上限后仍违规） */
  roleHarness: Partial<Record<RoleId, HarnessVerdict>>;
}

/**
 * 阶段 E2a 主函数：跑一条 watch 接力链。
 *
 * 核心循环（每跳）：
 *   1. controller.signal.aborted → 立即返 { stoppedAt: role }
 *   2. pickChainRoleModel(role, bindings, models) → 选模型；null 则跳过
 *   3. buildChainMessages(role, userTask, chainCtx, !!tools) → 构造 messages
 *   4. streamWithFallback([model], messages, callbacks, { signal, tools, maxToolSteps: 12 })
 *      ★ **tools 必传**——chain 角色能真干活，重演 M3 bug 防线
 *   5. **nudge 闭环**（H 阶段逻辑）：lastUsage.toolCallCount=0 + finishReason="stop" + 意图命中 → 回填 buildIntentNudgePrompt 重答一次
 *   6. executedRoles.push + onRoleDone → 继续下一跳
 *
 * 终止条件：① chain 跑完 ② controller.abort ③ 某跳无模型可用（跳过）
 *
 * @returns ChainResult：stoppedAt + executedRoles + skippedRoles
 */
export async function runChain(args: ChainArgs): Promise<ChainResult> {
  const executedRoles: { role: RoleId; content: string }[] = [];
  const skippedRoles: RoleId[] = [];
  const roleHarness: Partial<Record<RoleId, HarnessVerdict>> = {};

  // 防御：空 chain → 立即返（E1 已强制 chainPlan.length > 0 才触发，但保险）
  if (args.chain.length === 0) {
    return { stoppedAt: null, executedRoles, skippedRoles, roleHarness };
  }

  args.callbacks?.onChainStart?.(args.chain.length);

  for (let i = 0; i < args.chain.length; i++) {
    if (args.controller.signal.aborted) {
      return { stoppedAt: args.chain[i]!, executedRoles, skippedRoles, roleHarness };
    }

    const role = args.chain[i]!;
    const roleStartedAt = new Date().toISOString();
    args.callbacks?.onRoleStart?.(role, i, args.chain.length);

    // 1. 选模型
    const model = pickChainRoleModel(role, args.bindings, args.models);
    if (!model) {
      skippedRoles.push(role);
      args.callbacks?.onRoleDone?.(role, i, args.chain.length, `[角色 ${role} 无可用模型，已跳过]`);
      continue;
    }

    // 2. 构造 ChainContext + messages
    const chainCtx = buildChainContext({
      userTask: args.userTask,
      executedRoles,
    });
    const baseMessages = buildChainMessages(role, args.userTask, chainCtx, !!args.tools);

    // 3. 流式执行 + nudge 闭环（每跳最多 MAX_HARNESS_RETRY+1 次 LLM 调用）
    let content = "";
    let lastUsage: StreamUsage | undefined;
    let lastFinishReason = "stop";
    let lastContent = ""; // 保留 attempt=0 的 content 用于 nudge 重答时拼上下文
    let nudgeAttempted = false;
    let finalHarnessVerdict: HarnessVerdict | null = null;
    let correctionPrompt: string | null = null;

    for (let attempt = 0; attempt <= MAX_HARNESS_RETRY; attempt++) {
      if (args.controller.signal.aborted) break;
      content = "";
      if (attempt === 0) lastContent = "";

      const streamMessages: ChatMsg[] = attempt === 0
        ? baseMessages
        : [
            ...baseMessages,
            { role: "assistant", content: lastContent },
            { role: "user", content: correctionPrompt ?? buildIntentNudgePrompt() },
          ];

      // ★ tools 必传（命脉）：让 chain 角色能真调工具，否则重演 M3 "想干活没工具" bug
      const swf = args._deps?.streamWithFallback ?? streamWithFallback;
      try {
        await swf(
          [model],
          streamMessages,
          {
            onDelta: (delta) => {
              content += delta;
              args.callbacks?.onRoleDelta?.(role, delta);
            },
            onUsage: (u, m, fr) => {
              lastUsage = u;
              lastFinishReason = fr;
              args.callbacks?.onUsage?.(u, m, fr);
            },
            onSwitched: args.callbacks?.onSwitched
              ? (from, to, reason) => args.callbacks!.onSwitched!(from, to, reason)
              : undefined,
          },
          {
            signal: args.controller.signal,
            // ★ 必传：chain 角色要有真工具；fallback 模型自己也有 confirm 回调（来自 ChatPage 透传）
            ...(args.tools ? { tools: args.tools, maxToolSteps: 12 } : {}),
            // conversationId 透传给 streamWithFallback 让 UsageEvent 关联
            ...(args.conversationId ? { conversationId: args.conversationId } : {}),
            ...(args.projectId ? { projectId: args.projectId } : {}),
            // 阶段 F1：actorRole 透传（每跳 + nudge 重答都传同一 role，让 usage_events.role_kind 知道是哪个 actor）
            actorRole: role,
          },
        );
      } catch (err) {
        // 某跳模型调用失败 → 停止整条链（不重试别的角色）
        args.callbacks?.onRoleDone?.(role, i, args.chain.length, `[角色 ${role} 执行失败：${err instanceof Error ? err.message : String(err)}]`);
        return { stoppedAt: role, executedRoles, skippedRoles, roleHarness };
      }

      if (args.controller.signal.aborted) break;

      // 保存本轮 content 给 nudge 重答用
      if (attempt === 0) lastContent = content;

      // 4. H 阶段 nudge 检测：chain 内每跳也守"光说不做 → 催一次"
      //  - 必传了 tools 才检查（无工具任务不会触发）
      //  - finishReason=stop（abort / tool_error 不催）
      //  - toolCallCount=0
      //  - 文本含"我先/让我/我来"动手意图
      const toolCallCount = lastUsage?.toolCallCount ?? 0;
      const needsNudge =
        !!args.tools &&
        lastFinishReason === "stop" &&
        toolCallCount === 0 &&
        detectIntentNoToolCall(content);
      finalHarnessVerdict = args.harnessCheck
        ? await args.harnessCheck({
            role,
            content,
            attempt,
            hasTools: !!args.tools,
            startedAt: roleStartedAt,
            finishReason: lastFinishReason,
            toolCallCount,
            assistantMessageId: args.getCurrentMessageId?.() ?? null,
            judgeModel: args.judgeModel ?? null,
          })
        : null;
      const needsCorrection = !!(finalHarnessVerdict && !isClean(finalHarnessVerdict));
      if (needsCorrection && attempt < MAX_HARNESS_RETRY) {
        correctionPrompt = buildCorrectionPrompt(finalHarnessVerdict!, { hasTools: !!args.tools });
        lastContent = content;
        continue;
      }
      if (needsNudge && attempt < MAX_HARNESS_RETRY && !nudgeAttempted) {
        nudgeAttempted = true;
        correctionPrompt = buildIntentNudgePrompt();
        lastContent = content;
        continue;
      }
      break;
    }

    if (args.controller.signal.aborted) {
      args.callbacks?.onRoleDone?.(role, i, args.chain.length, content);
      return { stoppedAt: role, executedRoles, skippedRoles, roleHarness };
    }

    if (finalHarnessVerdict && !isClean(finalHarnessVerdict)) {
      roleHarness[role] = finalHarnessVerdict;
    }
    executedRoles.push({ role, content });
    args.callbacks?.onRoleDone?.(role, i, args.chain.length, content);
  }

  args.callbacks?.onChainDone?.(executedRoles);
  return { stoppedAt: null, executedRoles, skippedRoles, roleHarness };
}

// ============ 重新导出 ROLE_IDS 供 ChatPage 用（避免 ChatPage 多 import） ============
export { ROLE_IDS };
