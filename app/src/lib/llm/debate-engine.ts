// v0.8 阶段5 — 多角色对弈引擎（Solver / Critic / Judge）
//
// 病根（作者痛点 #2）：单模型说服不了自己，要手动开别的 AI 反驳再汇总。
// 解法：同一话题让三个角色协作——Solver 出方案 → Critic 对抗式挑刺 → Judge 裁决汇总——
// 消灭单模型"自我认知幻觉"，输出更稳健的方案。
//
// 设计：LLM 调用抽成可注入的 RunRole，引擎本身是纯编排逻辑、可单测（不打真 API）。
// 协议（Reflexion + Constitutional）：
//   1. Solver 看 topic 出方案
//   2. Critic 看 topic + Solver 方案，对抗式给"关键缺陷"
//   3. Judge 看 topic + 方案 + 批评，裁决出最终方案（返回结构化 JSON）
//   4. 若 Judge 判定 approved=false 且未达 maxIterations，Solver 基于 feedback 修正方案并重新进入循环
// 与方案文档的细节偏差：让 Critic 看到 Solver 方案（而非只看 topic），这样批评针对性更强、更有用。

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
  signal?: AbortSignal;
}

/** 注入的 LLM 执行器：production 用 getLanguageModel + generateText；测试用假实现 */
export type RunRole = (p: RunRoleParams) => Promise<{ content: string; inputTokens: number; outputTokens: number }>;

export interface DynamicDebateInput {
  topic: string;
  participants: DebateRoleConfig[];
  /** 最多使用多少个参与模型，默认 4。防止模型太多时成本和等待时间失控。 */
  maxParticipants?: number;
  /** 最大迭代次数，默认 2（即一次修正）。 */
  maxIterations?: number;
  signal?: AbortSignal;
}

export interface DebateResult {
  topic: string;
  rounds: RoleOutput[];
  finalSolution: string;
}

/** Judge 结构化裁决结果 */
export interface JudgeDecision {
  approved: boolean;
  feedback: string[];
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
    "请严格返回 JSON，格式如下：",
    "```json",
    "{",
    '  "approved": true,',
    '  "feedback": ["改进建议1", "改进建议2"],',
    '  "finalSolution": "合并并修正后的最终方案正文"',
    "}",
    "```",
    "其中 approved 为是否通过（true=方案可执行，false=需修改），",
    "feedback 为裁判给出的改进建议列表（approved 为 true 时可为空数组），",
    "finalSolution 为最终方案（若 approved 为 true，则与原方案相同或已修正）。",
    "务必不要在 JSON 之外输出任何内容，包括解释、换行或额外文字。",
  ].join("\n");
}

// ---- User prompt 构造 ----

function dynamicProposalUserPrompt(topic: string): string {
  return `任务/方案上下文：\n${topic}\n\n请先给出你认为最稳妥、可执行的方案。`;
}

function dynamicCritiqueUserPrompt(topic: string, solution: string): string {
  return [
    `任务/方案上下文：\n${topic}`,
    `\n待 PK 的方案：\n${solution}`,
    "\n请作为红队反方进行攻击：假设这个方案会失败，找出最可能导致失败的关键漏洞、错误假设、遗漏风险和执行断点。",
    "要求：输出结构化 Markdown，包含严重等级。",
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
      parts.push(`\n## ${critique.role} (${critique.modelId})\n${critique.content}`);
    }
  }
  parts.push("\n请综合上面的方案和反驳，给出最终判断。返回 JSON，字段: approved (bool), feedback (string[]), finalSolution (string)。");
  return parts.join("\n");
}

/**
 * 修正方案的 user prompt：当 Judge 判定 approved=false 时，
 * Solver 基于原方案 + 批评 + Judge 反馈重新出修正方案。
 */
export function dynamicProposalRevisionUserPrompt(args: {
  topic: string;
  previousSolution: string;
  critiques: RoleOutput[];
  judgeFeedback: string[];
}): string {
  const { topic, previousSolution, critiques, judgeFeedback } = args;
  const parts = [
    `任务/方案上下文：\n${topic}`,
    `\n上一次方案：\n${previousSolution}`,
  ];
  if (critiques.length > 0) {
    parts.push("\n以下是批评意见：");
    for (let i = 0; i < critiques.length; i++) {
      parts.push(`\n### 批评 ${i + 1} (${critiques[i]!.modelId})\n${critiques[i]!.content}`);
    }
  }
  if (judgeFeedback.length > 0) {
    parts.push("\n裁判给出的改进建议：");
    for (const f of judgeFeedback) {
      parts.push(`- ${f}`);
    }
  }
  parts.push("\n请基于上述信息生成修正后的方案，务必保持与原始方案相同的结构，仅在需要的地方做修改。");
  return parts.join("\n");
}

// ---- Judge JSON 解析 ----

/**
 * 鲁棒解析 Judge 输出为 JudgeDecision。
 * 支持：纯 JSON、markdown code fence 包裹的 JSON、以及 fallback 启发式提取。
 */
export function parseJudgeDecision(content: string): JudgeDecision {
  // 1) 尝试从 ```json ... ``` 中提取
  const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)```/i);
  const jsonString = jsonBlockMatch ? jsonBlockMatch[1]!.trim() : content.trim();

  try {
    const parsed = JSON.parse(jsonString);
    if (
      typeof parsed.approved === "boolean" &&
      Array.isArray(parsed.feedback) &&
      typeof parsed.finalSolution === "string"
    ) {
      return {
        approved: parsed.approved,
        feedback: parsed.feedback as string[],
        finalSolution: parsed.finalSolution,
      };
    }
  } catch {
    // JSON 解析失败，继续走启发式
  }

  // 2) 启发式 fallback —— 从非结构化文本中尽力提取
  const approvedMatch = content.match(/approved\s*[:=]\s*(true|false)/i);
  const approved = approvedMatch ? approvedMatch[1]!.toLowerCase() === "true" : false;

  let feedback: string[] = [];
  const feedbackMatch = content.match(/feedback\s*[:=]\s*\[([\s\S]*?)\]/i);
  if (feedbackMatch) {
    try {
      feedback = JSON.parse(`[${feedbackMatch[1]}]`);
    } catch {
      feedback = feedbackMatch[1]!
        .split(/[,，]/)
        .map((s) => s.replace(/^["'\s]+|["'\s]+$/g, ""))
        .filter(Boolean);
    }
  }

  const finalSolutionMatch = content.match(/finalSolution\s*[:=]\s*"([\s\S]*?)"/i);
  const finalSolution = finalSolutionMatch ? finalSolutionMatch[1]! : "";

  return { approved, feedback, finalSolution };
}

// ---- 工具函数 ----

function withRole(config: DebateRoleConfig, role: string): DebateRoleConfig {
  return { ...config, role };
}

function abortError(): Error {
  const err = new Error("AbortError");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function isAbort(err: unknown): boolean {
  return (err as { name?: string })?.name === "AbortError";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- 主引擎 ----

/**
 * 动态模型博弈：不再固定 3 个模型。
 * - 1 个模型：只能做单模型自审，明确不是 PK。
 * - 2 个模型：A 出方案，B 反驳，A 汇总裁决。
 * - 3+ 模型：第 1 个出方案，中间模型反驳，最后一个裁决；默认最多 4 个参与，避免成本失控。
 *
 * v0.8 新增：多轮收敛循环。Judge 返回 approved=false 时，
 * Solver 基于 feedback 修正方案，重新进入 Critic→Judge 循环，
 * 直到 approved=true 或达到 maxIterations。
 */
export async function runDynamicDebate(input: DynamicDebateInput, runRole: RunRole): Promise<DebateResult> {
  const participants = input.participants.slice(0, Math.max(1, input.maxParticipants ?? 4));
  const maxIterations = input.maxIterations ?? 2;
  if (participants.length === 0) {
    throw new Error("runDynamicDebate: participants cannot be empty");
  }

  const rounds: RoleOutput[] = [];
  // 降级关键：单个参与者失败不再让整场崩。proposer 失败→换下一个顶上；critic 失败→跳过；
  // judge 失败→用原方案兜底。失败原因收集起来附到最终产物，用户/我们能看清是哪个模型挂了。
  const failures: string[] = [];

  // ===== 单模型特判 =====
  if (participants.length === 1) {
    const soloConfig = withRole(participants[0]!, "solo_review");
    throwIfAborted(input.signal);
    const solo = await runRole({
      systemPrompt: [
        "你是单模型专家。当前只有一个可用模型，请发挥你的最佳分析能力。",
        "请对方案进行深入分析，指出潜在风险并给出修正后的优化方案。",
      ].join("\n"),
      userPrompt: dynamicProposalUserPrompt(input.topic),
      config: soloConfig,
      signal: input.signal,
    });
    rounds.push({ role: soloConfig.role, modelId: soloConfig.modelId, ...solo });
    return { topic: input.topic, rounds, finalSolution: solo.content };
  }

  // ===== 多模型多轮收敛循环 =====
  let proposal: RoleOutput | null = null;
  let proposerIdx = -1;
  let approved = false;
  let finalSolution = "";
  let judgeDecision: JudgeDecision | null = null;
  let critiques: RoleOutput[] = [];

  for (let iter = 0; iter < maxIterations && !approved; iter++) {
    // ---- 1) Proposer：出方案（iter=0 用原始 prompt，iter>0 用修正 prompt） ----
    const proposalPrompt = iter === 0
      ? dynamicProposalUserPrompt(input.topic)
      : dynamicProposalRevisionUserPrompt({
          topic: input.topic,
          previousSolution: proposal?.content ?? "",
          critiques,
          judgeFeedback: judgeDecision?.feedback ?? [],
        });

    proposal = null;
    proposerIdx = -1;
    for (let i = 0; i < participants.length; i++) {
      throwIfAborted(input.signal);
      const config = withRole(participants[i]!, "solver");
      try {
        const result = await runRole({
          systemPrompt: solverSystemPrompt(),
          userPrompt: proposalPrompt,
          config,
          signal: input.signal,
        });
        proposal = { role: config.role, modelId: config.modelId, ...result };
        proposerIdx = i;
        break;
      } catch (err) {
        if (isAbort(err)) throw err;
        failures.push(errMessage(err));
      }
    }
    if (!proposal) {
      throw new Error(`所有参与模型都无法出方案：\n${failures.join("\n")}`);
    }
    rounds.push(proposal);

    // ---- 2) 角色分配：critic / judge ----
    // ≥3 个参与者→judge 是最后一个、critics 是中间的；
    // 正好 2 个→proposer 兼任 judge、另一个当 critic。
    const rest = participants.filter((_, i) => i !== proposerIdx);
    const judgeSource = rest.length >= 2 ? rest[rest.length - 1]! : participants[proposerIdx]!;
    const judgeConfig = withRole(judgeSource, "judge");
    const criticSources = rest.length >= 2 ? rest.slice(0, -1) : rest;
    const criticConfigs = criticSources.map((p, index) =>
      withRole(p, index === 0 ? "critic" : `critic_${index + 1}`),
    );

    // ---- 3) Critics：逐个跑，失败的跳过、记下来，不阻断 ----
    critiques = [];
    for (const criticConfig of criticConfigs) {
      throwIfAborted(input.signal);
      try {
        const critique = await runRole({
          systemPrompt: criticSystemPrompt(),
          userPrompt: dynamicCritiqueUserPrompt(input.topic, proposal.content),
          config: criticConfig,
          signal: input.signal,
        });
        const output = { role: criticConfig.role, modelId: criticConfig.modelId, ...critique };
        critiques.push(output);
        rounds.push(output);
      } catch (err) {
        if (isAbort(err)) throw err;
        failures.push(errMessage(err));
      }
    }

    // ---- 4) Judge：结构化裁决 ----
    throwIfAborted(input.signal);
    try {
      const judgeRes = await runRole({
        systemPrompt: judgeSystemPrompt(),
        userPrompt: dynamicJudgeUserPrompt(input.topic, proposal.content, critiques),
        config: judgeConfig,
        signal: input.signal,
      });
      rounds.push({ role: judgeConfig.role, modelId: judgeConfig.modelId, ...judgeRes });
      judgeDecision = parseJudgeDecision(judgeRes.content);
      approved = judgeDecision.approved === true;
      finalSolution = judgeDecision.finalSolution || proposal.content;
    } catch (err) {
      if (isAbort(err)) throw err;
      failures.push(errMessage(err));
      // Judge 失败兜底：用原方案，标记未通过以便下轮重试
      approved = false;
      finalSolution = proposal.content;
      judgeDecision = null;
    }
    // 循环条件：!approved && iter < maxIterations
  }

  // ===== 附加失败摘要 =====
  if (failures.length > 0) {
    finalSolution += `\n\n---\n⚠️ 本场博弈有 ${failures.length} 个模型调用失败（已跳过）：\n${failures.map((f) => `- ${f}`).join("\n")}`;
  }

  return { topic: input.topic, rounds, finalSolution };
}
