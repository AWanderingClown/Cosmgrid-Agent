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
  role: string;
  modelId: string;
  modelName: string;
  providerType: string;
  providerId: string;
  apiCredentialId: string;
  apiKey: string;
  baseUrl?: string;
  workingDirectory?: string | null;
}

/** 一轮产物 */
export interface RoleOutput {
  role: string;
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

export interface DynamicDebateInput {
  topic: string;
  participants: DebateRoleConfig[];
  /** 最多使用多少个参与模型，默认 4。防止模型太多时成本和等待时间失控。 */
  maxParticipants?: number;
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
    "你是红队反方（Critic / Red Team）。你的任务不是补充建议，而是从完全对立面攻击方案。",
    "默认立场：方案可能是错的、不完整的、不可执行的、风险被低估的。你要找能推翻它的关键缺陷。",
    "要求：列出至多 3 条最关键攻击点，每条标注严重性（1-5）和「如果成立会造成什么后果」。",
    "禁止客套、禁止中立折中、禁止为了显得全面而凑小问题；只保留真正能改变决策的漏洞。",
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

function dynamicProposalUserPrompt(topic: string): string {
  return `任务/方案上下文：\n${topic}\n\n请先给出你认为最稳妥、可执行的方案。`;
}

function dynamicCritiqueUserPrompt(topic: string, solution: string): string {
  return [
    `任务/方案上下文：\n${topic}`,
    `\n待 PK 的方案：\n${solution}`,
    "\n请作为红队反方进行攻击：假设这个方案会失败，找出最可能导致失败的关键漏洞、错误假设、遗漏风险和执行断点。",
    "你的输出应该像红蓝对抗里的红队报告，而不是站在同一阵营的温和评审。",
  ].join("\n");
}

function dynamicJudgeUserPrompt(topic: string, solution: string, critiques: RoleOutput[]): string {
  const parts = [
    `任务/方案上下文：\n${topic}`,
    `\n原方案：\n${solution}`,
  ];
  if (critiques.length > 0) {
    parts.push("\n反驳 / PK 意见：");
    for (const critique of critiques) {
      parts.push(`\n## ${critique.modelId}\n${critique.content}`);
    }
  }
  parts.push("\n请综合上面的方案和反驳，给出最终判断：采纳什么、推翻什么、下一步应该怎么做。");
  return parts.join("\n");
}

function withRole(config: DebateRoleConfig, role: string): DebateRoleConfig {
  return { ...config, role };
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

/**
 * 动态模型博弈：不再固定 3 个模型。
 * - 1 个模型：只能做单模型自审，明确不是 PK。
 * - 2 个模型：A 出方案，B 反驳，A 汇总裁决。
 * - 3+ 模型：第 1 个出方案，中间模型反驳，最后一个裁决；默认最多 4 个参与，避免成本失控。
 */
export async function runDynamicDebate(input: DynamicDebateInput, runRole: RunRole): Promise<DebateResult> {
  const participants = input.participants.slice(0, Math.max(1, input.maxParticipants ?? 4));
  if (participants.length === 0) {
    throw new Error("runDynamicDebate: participants cannot be empty");
  }

  const rounds: RoleOutput[] = [];

  if (participants.length === 1) {
    const soloConfig = withRole(participants[0]!, "solo_review");
    const solo = await runRole({
      systemPrompt: [
        "你是单模型自审者。当前只有一个可用模型，不能伪装成多模型 PK。",
        "请直接说明无法进行真正多模型博弈，然后对方案做严格自审，给出可执行修正。",
      ].join("\n"),
      userPrompt: dynamicProposalUserPrompt(input.topic),
      config: soloConfig,
    });
    rounds.push({ role: soloConfig.role, modelId: soloConfig.modelId, ...solo });
    return { topic: input.topic, rounds, finalSolution: solo.content };
  }

  const proposerConfig = withRole(participants[0]!, "solver");
  const proposal = await runRole({
    systemPrompt: solverSystemPrompt(),
    userPrompt: dynamicProposalUserPrompt(input.topic),
    config: proposerConfig,
  });
  rounds.push({ role: proposerConfig.role, modelId: proposerConfig.modelId, ...proposal });

  const judgeConfig = withRole(participants.length >= 3 ? participants[participants.length - 1]! : participants[0]!, "judge");
  const criticConfigs = participants.length >= 3
    ? participants.slice(1, -1).map((p, index) => withRole(p, index === 0 ? "critic" : `critic_${index + 1}`))
    : [withRole(participants[1]!, "critic")];

  const critiques: RoleOutput[] = [];
  for (const criticConfig of criticConfigs) {
    const critique = await runRole({
      systemPrompt: criticSystemPrompt(),
      userPrompt: dynamicCritiqueUserPrompt(input.topic, proposal.content),
      config: criticConfig,
    });
    const output = { role: criticConfig.role, modelId: criticConfig.modelId, ...critique };
    critiques.push(output);
    rounds.push(output);
  }

  const judge = await runRole({
    systemPrompt: judgeSystemPrompt(),
    userPrompt: dynamicJudgeUserPrompt(input.topic, proposal.content, critiques),
    config: judgeConfig,
  });
  rounds.push({ role: judgeConfig.role, modelId: judgeConfig.modelId, ...judge });

  return { topic: input.topic, rounds, finalSolution: judge.content };
}
