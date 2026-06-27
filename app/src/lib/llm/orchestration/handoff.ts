// 阶段4 — Handoff 多 AI 协作（抄微软 MAF orchestrations/_handoff.py）。
//
// 病根（产品真北痛点#2）：单模型说服不了自己，要手动开别的 AI 反驳再汇总。
// 解法：每个 ExpertAgent 带 handoff_to_{target} 工具，模型调用它即被拦截、切目标 agent。
// Agent 自己决定转给谁——真"多 AI 协作"，比 debate-engine 的固定 3 角色更动态。
//
// 本文件：纯函数核心（工具名生成 + 决策解析 + 默认关系表），可单测。
// runHandoffWorkflow 是集成骨架（要接 streamText + ChatPage），标 TODO 待 UI 接入。

import type { RoleId } from "../orchestrator";
import { tool, type Tool } from "ai";
import { z } from "zod";

export interface HandoffTarget {
  targetId: string;
  description?: string;
}

export interface ExpertAgent {
  id: string;
  modelId: string;
  systemPrompt: string;
  /** 这个 agent 可以 handoff 给哪些目标 */
  handoffs: HandoffTarget[];
}

export const HANDOFF_TOOL_PREFIX = "handoff_to_";

/** 生成 handoff 工具名：handoff_to_{targetId}（targetId 只保留 \w-，防注入） */
export function makeHandoffToolName(targetId: string): string {
  const safe = targetId.replace(/[^\w-]/g, "_");
  return `${HANDOFF_TOOL_PREFIX}${safe}`;
}

/** 从工具名反解 targetId；不是 handoff 工具返回 null */
export function parseHandoffTargetId(toolName: string): string | null {
  if (!toolName.startsWith(HANDOFF_TOOL_PREFIX)) return null;
  return toolName.slice(HANDOFF_TOOL_PREFIX.length);
}

/**
 * 从模型返回的 toolCalls 里解析 handoff 决策。
 * @param toolCalls 本步模型的工具调用
 * @param handoffTargetIds 当前 agent 合法的 handoff 目标（防模型乱调未授权的）
 * @returns 要转去的 targetId，或 null（没 handoff，该 agent 自己答完了）
 */
export function parseHandoffDecision(
  toolCalls: { toolName: string; input?: unknown }[],
  handoffTargetIds: string[],
): string | null {
  const valid = new Set(handoffTargetIds.map((id) => makeHandoffToolName(id)));
  for (const tc of toolCalls) {
    if (valid.has(tc.toolName)) {
      return parseHandoffTargetId(tc.toolName);
    }
  }
  return null;
}

/**
 * 给一组 handoff 目标生成 AI SDK 工具 schema。
 * 每个目标 → 一个工具，工具名 = `handoff_to_{targetId}`。
 *
 * execute 是 noop——handoff 引擎在 streamText step.run 之后用 parseHandoffDecision 拦截
 * 真正的 handoff 决策，不让 execute 跑（避免给用户看到奇怪的 "handoff_triggered" 字符串）。
 */
export function buildHandoffTools(targets: HandoffTarget[]): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const t of targets) {
    const toolName = makeHandoffToolName(t.targetId);
    out[toolName] = tool({
      description: `转交给 ${t.targetId}：${t.description ?? ""}`,
      inputSchema: z.object({
        reason: z.string().describe("为什么转交（让用户看到原因）"),
      }),
      // noop：handoff 引擎在 streamText step 后用 parseHandoffDecision 拦截
      execute: async () => "handoff_triggered",
    });
  }
  return out;
}

/**
 * 默认 8 角色 handoff 关系表（产品真北痛点#2 落地）。
 *
 * 设计原则（2026-06-27 用户拍板）：
 * 1. **Leader 是协调者** → 可踢给任何专家
 * 2. **Architect 是桥梁** → 跟前后端互转（设计↔实现）
 * 3. **Frontend/Backend 是执行者** → 跟对方 + Runner + Architect 互转
 * 4. **Runner 是工具使用者** → 跑完让 Tester 验
 * 5. **Tester/Reviewer/Security 是把关者** → 单向流转（tester→reviewer→security 不回头，防踢皮球）
 * 6. **Security 是终点** → 不转出，任务收尾
 *
 * 这是**默认配置**，用户可在 SettingsPage 配自己的图（E2 阶段做）。
 */
export function defaultEightRolesHandoffGraph(): Record<RoleId, HandoffTarget[]> {
  return {
    // Leader 协调者：可以 handoff 给任何专家
    leader: [
      { targetId: "architect", description: "让架构评审出技术方案" },
      { targetId: "frontend", description: "交给前端工程师实现 UI" },
      { targetId: "backend", description: "交给后端工程师实现 API/库" },
      { targetId: "runner", description: "让 Runner 跑命令（build/lint/test）" },
      { targetId: "tester", description: "让测试工程师验证" },
      { targetId: "reviewer", description: "让审查工程师复核质量" },
      { targetId: "security", description: "让安全工程师检查密钥/注入/支付" },
    ],
    // Architect 桥梁：跟前后端互转（设计↔实现）
    architect: [
      { targetId: "frontend", description: "让前端工程师按方案实现 UI" },
      { targetId: "backend", description: "让后端工程师按方案实现 API/库" },
    ],
    // Frontend 执行者：需要后端/架构确认/Runner 跑
    frontend: [
      { targetId: "backend", description: "需要后端配合（如调用 API）" },
      { targetId: "architect", description: "需要架构确认设计变更" },
      { targetId: "runner", description: "让 Runner 跑 build/lint/preview" },
    ],
    // Backend 执行者：需要前端配合/Runner 跑测试
    backend: [
      { targetId: "frontend", description: "需要前端配合（联调接口）" },
      { targetId: "runner", description: "让 Runner 跑 test/db migrate" },
    ],
    // Runner 工具使用者：跑完让 Tester 验
    runner: [
      { targetId: "tester", description: "让测试工程师验证结果" },
    ],
    // Tester 把关者：通过 → reviewer，未通过 → security 或回 leader（但这里简化：单向流转）
    tester: [
      { targetId: "reviewer", description: "让审查工程师复核代码质量" },
      { targetId: "security", description: "让安全工程师检查（涉及用户数据/支付时）" },
    ],
    // Reviewer 把关者：可通过 → security 终审
    reviewer: [
      { targetId: "security", description: "让安全工程师终审" },
    ],
    // Security 终点：不转出，任务收尾
    security: [],
  };
}

export interface HandoffWorkflowOptions {
  /** 最大 handoff 次数（防 agent 互相踢皮球），默认 5 */
  maxHandoffs?: number;
}

export interface HandoffWorkflowResult {
  /** 最终展示给用户的内容（最后一个 agent 的回答） */
  finalContent: string;
  /** agent 接力路径，如 ["leader", "frontend", "tester"] */
  handoffPath: string[];
  /** 链条被 maxHandoffs 截断时 = true，UI 可标黄提示 */
  truncated?: boolean;
  /** runStep 抛错时填这个，UI 可显示给用户（不 throw 出去，避免炸主对话） */
  error?: string;
}

/**
 * 跑 handoff workflow（E1 纯函数实现，未接 streamText——T22 接 ChatPage 时再补）。
 *
 * 循环：当前 agent 跑 runStep（streamText 调用，外面注入）→ 检测 handoff 决策
 *      → 切目标 agent（上下文交接）→ 继续。
 *
 * 终止：① 没 handoff 决策（agent 自己答完）② 达到 maxHandoffs ③ runStep 抛错 ④ agents map 缺 id。
 *
 * 上下文交接：当前 agent 的 content 作为 assistant message 加入；handoff reason 作为
 * system 提示 user message 加入——下个 agent 接手时知道为什么被打断 + 之前发生了什么。
 */
export async function runHandoffWorkflow(
  startAgentId: string,
  agents: Map<string, ExpertAgent>,
  input: string,
  runStep: (agent: ExpertAgent, messages: { role: string; content: string }[]) => Promise<{
    content: string;
    toolCalls: { toolName: string; input?: unknown }[];
  }>,
  options?: HandoffWorkflowOptions,
): Promise<HandoffWorkflowResult> {
  const maxHandoffs = options?.maxHandoffs ?? 5;
  const path: string[] = [startAgentId];
  // 不可变更新：每次循环用 spread 创建新数组（不用 push），让 mock.calls 看到的快照稳定
  let messages: { role: "user" | "assistant" | "system"; content: string }[] = [
    { role: "user", content: input },
  ];

  // 循环：每次跑当前 agent 的 runStep
  while (true) {
    const currentId = path[path.length - 1];
    const currentAgent = agents.get(currentId);
    if (!currentAgent) {
      return {
        finalContent: messages[messages.length - 1]?.content ?? "",
        handoffPath: path,
        error: `Agent "${currentId}" not found in agents map`,
      };
    }

    let stepResult: { content: string; toolCalls: { toolName: string; input?: unknown }[] };
    try {
      stepResult = await runStep(currentAgent, messages);
    } catch (err) {
      // runStep 抛错 → 不炸主对话，返回最后一个 content + error
      return {
        finalContent: messages[messages.length - 1]?.content ?? "",
        handoffPath: path,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // 当前 agent 的回答入 messages（上下文交接给下一跳）—— 不可变 push
    messages = [...messages, { role: "assistant", content: stepResult.content }];

    // 检测 handoff 决策：模型是否调了 handoff_to_X（且 X 在当前 agent 允许的目标里）
    const allowedTargetIds = currentAgent.handoffs.map((t) => t.targetId);
    const handoffTarget = parseHandoffDecision(stepResult.toolCalls, allowedTargetIds);

    if (!handoffTarget) {
      // 没 handoff → 当前 agent 答完了
      return { finalContent: stepResult.content, handoffPath: path };
    }

    // 检查链条上限：path.length 是已访问 agent 数（含 startAgent）
    // handoff N 次后 path.length = N+1，达到上限 = 不能再加
    if (path.length >= maxHandoffs + 1) {
      // 截断：返回当前 agent 的回答，标 truncated
      return {
        finalContent: stepResult.content,
        handoffPath: path,
        truncated: true,
      };
    }

    // 切到目标 agent
    path.push(handoffTarget);

    // 提取 handoff reason（让下个 agent 知道为什么接手）
    const handoffCall = stepResult.toolCalls.find(
      (tc) => parseHandoffTargetId(tc.toolName) === handoffTarget
    );
    const reasonStr =
      handoffCall?.input && typeof handoffCall.input === "object" && "reason" in handoffCall.input
        ? String((handoffCall.input as { reason: unknown }).reason)
        : "";

    messages = [
      ...messages,
      {
        role: "user",
        content: `[System handoff] 上一个角色（${currentId}）决定把任务转交给你（${handoffTarget}）继续处理。原因：${reasonStr || "未说明"}`,
      },
    ];
  }
}
