// Harness 工程实施计划 阶段6 — 4 个 Apply 函数（纯函数）。
//
// 4 张允许修改的表面（计划文件 §第一版允许优化的表面）：
// 1. applyToPrompt                 — skill_instruction 插入 system prompt
// 2. applyToToolDescriptions        — tool_description_override（不修改 security / readOnly / parameters）
// 3. applyToToolResultRenderer      — tool_result_format_hint 包装
// 4. applyToRetryPolicy             — retry_policy_override 覆盖 maxRetries / maxContextOverflowRetries
//
// 关键不变量（plan §永远不允许自动修改）：
// - 不可修改 security / readOnly / parameters / commandSafety 等安全语义
// - 不可写 project_memories
// - 不可自动 enabled=true（用户必须显式批准）
// - 不可修改审计日志 / DB 迁移 runner / 权限判定

import type { AdaptationRule, ResolvedModelHarnessProfile } from "./types";

/** 工具定义（最小集）—— 不重造 ToolDefinition 全字段，只用 apply 需要的 */
interface ToolDefLike {
  name: string;
  description: string;
  security?: unknown;
  readOnly?: boolean;
  parameters?: unknown;
  // 其他字段 apply 不动
  [k: string]: unknown;
}

/** RetryPolicy 形状（阶段6 第一版只覆盖 maxRetries + maxContextOverflowRetries） */
export interface RetryPolicy {
  maxRetries: number;
  maxContextOverflowRetries: number;
}

/** 1. applyToPrompt：把 skill_instruction adaptation 插入 system prompt
 *  - 输出文本不写 conversation history
 *  - 多个 skill_instruction 用 \n---\n 分隔 */
export function applyToPrompt(profile: ResolvedModelHarnessProfile | null, baseSystemPrompt: string): string {
  if (!profile) return baseSystemPrompt;
  const instructions = profile.mergedAdaptations
    .filter((r): r is Extract<AdaptationRule, { kind: "skill_instruction" }> => r.kind === "skill_instruction")
    .map((r) => r.content);
  if (instructions.length === 0) return baseSystemPrompt;
  return `${baseSystemPrompt}\n\n--- Model-specific notes ---\n${instructions.join("\n---\n")}`;
}

/** 2. applyToToolDescriptions：临时覆盖 tool description
 *  - **不修改** security / readOnly / parameters（hard block 显式禁止项）
 *  - 没 override 的 tool 保持原样 */
export function applyToToolDescriptions<T extends ToolDefLike>(
  profile: ResolvedModelHarnessProfile | null,
  registry: T[],
): T[] {
  if (!profile) return registry;
  const overrides = new Map<string, string>();
  for (const r of profile.mergedAdaptations) {
    if (r.kind === "tool_description_override") {
      overrides.set(r.toolName, r.descriptionOverride);
    }
  }
  if (overrides.size === 0) return registry;
  return registry.map((tool) => {
    const newDesc = overrides.get(tool.name);
    if (!newDesc) return tool;
    // 不可修改 security / readOnly / parameters（plan §关键不变量）
    return { ...tool, description: newDesc };
  });
}

/** 3. applyToToolResultRenderer：包装 renderResultForModel，加 tool_result_format_hint
 *  - plan §F 步骤 3：只允许添加"如何解读错误/下一步"的说明
 *  - 不允许隐藏 error_code / error_stop_condition / artifacts */
export function applyToToolResultRenderer(
  profile: ResolvedModelHarnessProfile | null,
  baseRender: (toolResult: unknown) => string,
): (toolResult: unknown) => string {
  if (!profile) return baseRender;
  const hints = profile.mergedAdaptations
    .filter((r): r is Extract<AdaptationRule, { kind: "tool_result_format_hint" }> => r.kind === "tool_result_format_hint")
    .map((r) => ({ key: r.templateKey, snippet: r.snippet }));
  if (hints.length === 0) return baseRender;
  return (toolResult) => {
    const base = baseRender(toolResult);
    const hintBlock = hints.map((h) => `<!-- ${h.key} -->\n${h.snippet}`).join("\n");
    return `${base}\n${hintBlock}`;
  };
}

/** 4. applyToRetryPolicy：覆盖 maxRetries / maxContextOverflowRetries
 *  - 第一版只支持 retry_policy_override 覆盖（不引入新 policy 字段） */
export function applyToRetryPolicy(
  profile: ResolvedModelHarnessProfile | null,
  basePolicy: RetryPolicy,
): RetryPolicy {
  if (!profile) return basePolicy;
  const overrides = profile.mergedAdaptations
    .filter((r): r is Extract<AdaptationRule, { kind: "retry_policy_override" }> => r.kind === "retry_policy_override");
  if (overrides.length === 0) return basePolicy;
  // 取最后一个 override（priority 排序后最后一个 = 最高 priority）
  const last = overrides[overrides.length - 1]!;
  return {
    maxRetries: last.maxRetries ?? basePolicy.maxRetries,
    maxContextOverflowRetries: last.maxContextOverflowRetries ?? basePolicy.maxContextOverflowRetries,
  };
}