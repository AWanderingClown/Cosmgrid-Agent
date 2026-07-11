// Harness 工程实施计划 阶段3 — 证据链（Evidence Chain）类型定义。
//
// 设计动机：阶段1 + 阶段2 的 verifyNodeOutcome / ToolResultV2 解决了"非空回答 + Harness 干净 +
// 结构化工具结果"，但没有解决"回答里的具体声明是不是真有证据"——这是细对账层。阶段3 把每条
// 关键声明（修改了哪些文件 / 跑了哪些命令 / 测试通过多少项 / 是否满足验收标准）链接到真实的
// ToolExecutionRow / ToolArtifactRef，输出统一 VerificationResult 让 UI 直接展示"证据 +
// 冲突 + 验收决定"。
//
// 核心约束（来自计划文件 §核心不变量）：
// - "完成必须有证据，不由模型自我宣布" → Task Verifier 只消费结构化事实（不接受文本猜）
// - "Task Verifier 只消费结构化事实，不依赖回答文案猜测" → 所有 verdict 由声明 ↔ 证据的
//   匹配结果决定，不由 LLM 自由文本判定
// - "evidence/ 不允许反向依赖 workflow/" → 这里所有 import 都用 `import type`，运行时无依赖
//
// ID 空间：EvidenceRef.id 用 crypto.randomUUID()（Node 18+ 内置）。`kind=tool_execution`
// 时 `toolExecutionId` 字段再绑一次 ToolExecutionRow.id（双重锚点：EvidenceRef.id 给 UI
// 用，toolExecutionId 给 SQL JOIN 用）。

import type { ToolArtifactRef } from "@/lib/llm/tools/result-contract";

/** 一条结构化证据的不可变引用。 */
export interface EvidenceRef {
  /** 主键，由 evidence-builder 生成（crypto.randomUUID）。 */
  id: string;
  /** 证据类别，决定 UI 怎么渲染 + Task Verifier 怎么匹配。 */
  kind: "tool_execution" | "artifact" | "user_confirmation" | "structured_criterion";
  /** 工具名 / artifact uri / "user-confirmed:<turnId>" / skill 名 等人类可读来源。 */
  source: string;
  /** ≤ 120 字符人类可读摘要（tool 输出前 120 字符 / artifact label / 用户确认的具体内容）。 */
  summary: string;
  /** 证据发生时间（ISO-8601）。 */
  occurredAt: string;
  /** kind=tool_execution 时填，关联到 tool_executions 主键。 */
  toolExecutionId?: string;
  /** kind=artifact 时填，复用阶段2 的 ToolArtifactRef（不重复定义）。 */
  artifact?: ToolArtifactRef;
  /** 关联的 WorkflowSnapshot.runId + nodeId，用于审计回溯 + UI 跳转。 */
  workflowRef?: { runId: string; nodeId: string };
  /**
   * 证据被截断 / 降级（如 result 输出超过 MAX_OUTPUT_CHARS / tool_executions.result_json 解析失败）。
   * true 时 UI 显示 ⚠ unknown 标记，Task Verifier 把 verdict 标 unknown 而不是 supported。
   */
  truncated?: boolean;
}

/** 一条声明分类 —— 五类对应计划文件 §工作项 3 的关键声明。 */
export type ClaimKind =
  | "file_modified" // 声称修改了某文件（需 write/edit 记录）
  | "command_executed" // 声称跑了某命令（需 bash 成功记录）
  | "test_result" // 声称测试通过 X 项（需 bash 输出数字匹配）
  | "url_fetched" // 声称抓了某 URL（需 web_fetch 成功记录）
  | "acceptance_met"; // 声称满足某验收标准（需 StructuredAcceptanceCriterion 验证）

/** 单声明对账结论。 */
export type ClaimVerdict =
  | "supported" // 有强证据支持
  | "insufficient" // 缺证据（不是"被反驳"，是"没看到"）
  | "contradicts" // 有证据但与声明相反（关键场景：bash 报错却说构建通过）
  | "unknown"; // 证据被截断 / legacy 数据无法判定

/** 一条从模型回答里抽取的声明 + 链接到的证据 ID + 对账结论。 */
export interface LinkedClaim {
  /** 声明 ID，由 claim-extractor 生成（uuid）。 */
  claimId: string;
  kind: ClaimKind;
  /** 原始声明文本（≤ 200 字符），用于 UI 展示 + 调试。 */
  text: string;
  /** 关联 EvidenceRef.id 列表（空数组 = insufficient）。 */
  evidenceIds: string[];
  /** 对账结论（见 ClaimVerdict）。 */
  verdict: ClaimVerdict;
  /** verdict === "contradicts" 时填人类可读的冲突原因（如 "claimed=10 tests, evidence=8"）。 */
  conflictReason?: string;
}

/**
 * 阶段3 verification_closure skill 的结构化验收标准 —— 替代旧 string[]。
 *
 * 注意：check 函数不放在这里，structured-criteria.ts 通过 kind 调度实现，
 * registry.ts 只需要声明 id + description + kind（无需反向依赖 evidence 模块的运行时）。
 */
export interface StructuredAcceptanceCriterion {
  /** 稳定字符串 ID（如 "tests_pass" / "typecheck_pass"），用于 Task Verifier 引用。 */
  id: string;
  description: string;
  kind: "test_run" | "typecheck" | "lint" | "build" | "manual";
}

/** 向后兼容：旧 SkillDefinition.acceptanceCriteria 仍接受 string。 */
export type AcceptanceCriterion = string | StructuredAcceptanceCriterion;

/** 整次回答的验收结果 —— 阶段3 主输出。 */
export interface VerificationResult {
  /**
   * 整体状态：
   * - passes：所有声明 supported + 所有验收标准 met
   * - fails：至少一条 verdict === "contradicts"
   * - inconclusive：证据不足 / 截断 / 加载失败 等"看不清"场景——**不是失败**
   */
  status: "passes" | "fails" | "inconclusive";
  /** 满足的验收标准 ID 列表（来自 verification_closure skill）。 */
  metCriteria: string[];
  /** 未满足的验收标准 ID 列表。 */
  failedCriteria: string[];
  /** 全部对账后的 LinkedClaim（含 supported / insufficient / contradicts / unknown）—— UI 完整展示用。 */
  linkedClaims: LinkedClaim[];
  /** 只含 verdict === "contradicts" 的 LinkedClaim —— UI 高亮冲突用。 */
  conflicts: LinkedClaim[];
  /** 决策时间戳 + 决策依据的 evidence id 列表。 */
  decidedAt: string;
  decisionEvidenceIds: string[];
  /** ≤ 200 字符人类可读摘要（UI 折叠态直接展示这一行）。 */
  humanSummary: string;
}