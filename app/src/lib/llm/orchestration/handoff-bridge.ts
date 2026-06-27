// 阶段4 — Handoff 桥接层（E1 完成后接 ChatPage 的 glue）
//
// 职责：
// 1. 把 ChatPage 的运行时数据（availableModels / roleBindings / selectedModel）
//    转换成 ExpertAgent Map
// 2. 用 runStep callback 包装 chat-fallback 的 streamText（外面注入，避开 chat-fallback 直接依赖）
// 3. 调 runHandoffWorkflow（见 ./handoff.ts）
//
// 设计：
// - 不依赖 ChatPage 的 React 状态，单纯接收参数 + 注入 callback → 可单测
// - runStep 是 callback，ChatPage 提供（用 chat-fallback 的 streamText 实现）
// - 失败静默（runHandoffWorkflow 内部已 try/catch，result.error 填上即可）

import {
  defaultEightRolesHandoffGraph,
  parseHandoffDecision,
  runHandoffWorkflow,
  buildHandoffTools,
  type ExpertAgent,
  type HandoffWorkflowResult,
} from "./handoff";
import type { RoleId } from "../orchestrator";

/** ChatPage 提供的"模型可用性"摘要（避免 handoff-bridge 直接依赖 React state） */
export interface HandoffBridgeModelRef {
  /** 模型唯一 id */
  id: string;
  /** 模型显示名（给 system prompt 用） */
  displayName: string;
  /** 该模型是否绑定了某个角色（roleBindings 的反向映射） */
  roleBinding?: RoleId;
}

/**
 * 从 ChatPage 的 availableModels + roleBindings + selectedModel 派生 ExpertAgent Map。
 * 派生原则：
 * - 每个 RoleId（leader/architect/...）必须有 agent，否则 map 里缺
 * - 角色绑定优先：用户给 frontend 绑了 minimax → frontendAgent.modelId = minimax
 * - 用户手选的 selectedModel → leader agent（leader 是入口）
 * - 缺角色绑定的 agent → 用 selectedModel 占位（向后兼容）
 */
export function deriveExpertAgentMap(
  roleBindings: Partial<Record<RoleId, string>>,
  selectedModelId: string,
  models: HandoffBridgeModelRef[],
  systemPrompts?: Partial<Record<RoleId, string>>,
): Map<string, ExpertAgent> {
  const byId = new Map(models.map((m) => [m.id, m]));
  const graph = defaultEightRolesHandoffGraph();
  const map = new Map<string, ExpertAgent>();
  for (const roleId of Object.keys(graph) as RoleId[]) {
    // 角色绑的 model 优先，否则用 selectedModel
    const boundModelId = roleBindings[roleId] ?? selectedModelId;
    const model = byId.get(boundModelId);
    if (!model) continue; // 模型不可用 → 跳过该角色
    map.set(roleId, {
      id: roleId,
      modelId: boundModelId,
      systemPrompt: systemPrompts?.[roleId] ?? `You are the ${roleId} of a software engineering team.`,
      handoffs: graph[roleId],
    });
  }
  return map;
}

/**
 * 检查 main chat 的 toolCalls 是否含 handoff 决策（返回 targetId 或 null）。
 * 简单 wrapper，避免 ChatPage 重复 import parseHandoffDecision。
 */
export function extractHandoffDecisionFromToolCalls(
  toolCalls: { toolName: string; input?: unknown }[],
  currentRoleHandoffs: { targetId: string }[],
): string | null {
  return parseHandoffDecision(
    toolCalls,
    currentRoleHandoffs.map((h) => h.targetId),
  );
}

/**
 * ChatPage 的 main chat 完成后调用：调 runHandoffWorkflow。
 *
 * 触发条件：main chat 的 toolCalls 含 handoff_to_X 决策。
 * 否则 noop 返回 null。
 *
 * 失败静默：runHandoffWorkflow 内部 try/catch + error 填 result，主对话不炸。
 */
export async function runHandoffBridge(args: {
  /** 起点角色（通常是 "leader"） */
  startRoleId: RoleId;
  /** main chat 的输出 + 用户输入 + 历史 messages */
  messages: { role: "user" | "assistant" | "system"; content: string }[];
  /** 派生好的 ExpertAgent map */
  agents: Map<string, ExpertAgent>;
  /** main chat 的 toolCalls（检查是否含 handoff 决策） */
  mainChatToolCalls: { toolName: string; input?: unknown }[];
  /** ChatPage 提供的 streamText callback（避开 chat-fallback 直接依赖） */
  runStep: (
    agent: ExpertAgent,
    messages: { role: string; content: string }[],
  ) => Promise<{ content: string; toolCalls: { toolName: string; input?: unknown }[] }>;
  /** maxHandoffs 默认 5 */
  maxHandoffs?: number;
  /** 中止信号（user 中断对话时触发） */
  signal?: AbortSignal;
}): Promise<HandoffWorkflowResult | null> {
  // 触发检查：main chat 必须先调了 handoff
  const startAgent = args.agents.get(args.startRoleId);
  if (!startAgent) return null;
  const decision = extractHandoffDecisionFromToolCalls(
    args.mainChatToolCalls,
    startAgent.handoffs,
  );
  if (!decision) return null; // main chat 没调 handoff，不触发

  return runHandoffWorkflow(args.startRoleId, args.agents, args.messages[args.messages.length - 1]?.content ?? "", args.runStep, {
    maxHandoffs: args.maxHandoffs ?? 5,
  });
}

/**
 * 给一组 ExpertAgent 合并出 handoff 工具 schema（按 startAgent 的 handoffs）。
 * 用途：ChatPage 把这些工具注入 main chat 的 tools 数组，让 main chat 模型能调 handoff_to_X。
 */
export function buildHandoffToolsForAgent(agent: ExpertAgent): ReturnType<typeof buildHandoffTools> {
  return buildHandoffTools(agent.handoffs);
}