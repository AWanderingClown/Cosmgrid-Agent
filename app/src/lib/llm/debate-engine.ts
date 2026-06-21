// v0.8 阶段5 — 多角色对弈引擎（Solver / Critic / Judge）
//
// 病根（作者痛点 #2）：单模型说服不了自己，要手动开别的 AI 反驳再汇总。
// 解法：同一话题让三个角色协作——Solver 出方案 → Critic 对抗式挑刺 → Judge 裁决汇总——
// 消灭单模型"自我认知幻觉"，输出更稳健的方案。
//
// 设计：LLM 调用抽成可注入的 RunRole，引擎本身是纯编排逻辑、可单测（不打真 API）。
// 协议（Reflexion + Constitutional）：
//   1. Solver 看 topic 出方案
//   2. Critic 看 topic + Solver 方案，对抗式给"关键缺陷"（quickMode 跳过）
//   3. Judge 看 topic + 方案 + 批评，裁决出最终方案
// 与方案文档的细节偏差：让 Critic 看到 Solver 方案（而非只看 topic），这样批评针对性更强、更有用。

export type DebateRole = "solver" | "critic" | "judge";

/** 一个角色用哪个模型（端点信息，复用 provider-factory 调用） */
export interface DebateRoleConfig {
  role: DebateRole;
  modelId: string;
  modelName: string;
  providerType: string;
  providerId: string;
  apiCredentialId: string;
  apiKey: string;
  baseUrl?: string;
}

/** 一轮产物 */
export interface RoleOutput {
  role: DebateRole;
  modelId: string;
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface RunRoleParams {
  systemPrompt: string;
  userPrompt: string;
  config: DebateRoleConfig;
}

/** 注入的 LLM 执行器：production 用 getLanguageModel + generateText；测试用假实现 */
export type RunRole = (p: RunRoleParams) => Promise<{ content: string; inputTokens: number; outputTokens: number }>;

export interface DebateInput {
  topic: string;
  solver: DebateRoleConfig;
  critic: DebateRoleConfig;
  judge: DebateRoleConfig;
  /** 快速模式：跳过 Critic，只 Solver + Judge（省 ~1/3 token） */
  quickMode?: boolean;
}

export interface DebateResult {
  topic: string;
  rounds: RoleOutput[];
  finalSolution: string;
}

// ---- Prompt 构造（导出便于单测/调参） ----

export function solverSystemPrompt(): string {
  return [
    "你是方案设计者（Solver）。针对用户给的话题，给出清晰、具体、可执行的方案。",
    "要求：列出关键步骤；指出依赖与风险；对不确定处明确标注假设。",
    "原则：事实准确、完整、可执行、有风险意识、避免空话。",
  ].join("\n");
}

export function criticSystemPrompt(): string {
  return [
    "你是对抗式审查者（Critic）。下面给你一个话题和某方案，你的任务是找出方案的关键缺陷。",
    "要求：列出至多 3 条最关键的缺陷，每条标注严重性（1-5）。",
    "对每条自问：如果这条不成立，会不会推翻整个方案？只保留真正要害的，不要凑数、不要客套。",
  ].join("\n");
}

export function judgeSystemPrompt(): string {
  return [
    "你是裁判（Judge）。综合话题、方案与批评，产出最终方案。",
    "按 5 个维度权衡：事实准确性 / 完整性 / 可执行性 / 风险评估 / 创新性。",
    "采纳方案中成立的部分，修正被批评击中的缺陷，最终给出一份可直接执行的方案 + 一句话结论（采纳/需修改/拒绝）。",
  ].join("\n");
}

function solverUserPrompt(topic: string): string {
  return `话题：${topic}\n\n请给出你的方案。`;
}

function criticUserPrompt(topic: string, solution: string): string {
  return `话题：${topic}\n\n待审查的方案：\n${solution}\n\n请给出关键缺陷。`;
}

function judgeUserPrompt(topic: string, solution: string, critique: string | null): string {
  const parts = [`话题：${topic}`, `\nSolver 方案：\n${solution}`];
  if (critique) parts.push(`\nCritic 批评：\n${critique}`);
  parts.push("\n请产出最终方案。");
  return parts.join("\n");
}

/**
 * 跑一场对弈。runRole 注入，引擎只负责编排与上下文传递。
 * 任一角色抛错则整场抛错（调用方决定是否重试/降级）。
 */
export async function runDebate(input: DebateInput, runRole: RunRole): Promise<DebateResult> {
  const rounds: RoleOutput[] = [];

  // 1. Solver
  const solver = await runRole({
    systemPrompt: solverSystemPrompt(),
    userPrompt: solverUserPrompt(input.topic),
    config: input.solver,
  });
  rounds.push({ role: "solver", modelId: input.solver.modelId, ...solver });

  // 2. Critic（quickMode 跳过）
  let critique: string | null = null;
  if (!input.quickMode) {
    const critic = await runRole({
      systemPrompt: criticSystemPrompt(),
      userPrompt: criticUserPrompt(input.topic, solver.content),
      config: input.critic,
    });
    critique = critic.content;
    rounds.push({ role: "critic", modelId: input.critic.modelId, ...critic });
  }

  // 3. Judge
  const judge = await runRole({
    systemPrompt: judgeSystemPrompt(),
    userPrompt: judgeUserPrompt(input.topic, solver.content, critique),
    config: input.judge,
  });
  rounds.push({ role: "judge", modelId: input.judge.modelId, ...judge });

  return {
    topic: input.topic,
    rounds,
    finalSolution: judge.content,
  };
}
