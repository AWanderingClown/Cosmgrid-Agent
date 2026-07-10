// Harness 工程实施计划阶段1 —— 节点验收器。
//
// 病根（文档原话）："只要有非空回复且没有被中断，就可能调用 completeCurrentWorkflowNode()"。
// 这里把"回答非空"换成"独立验收器确认节点目标已经满足"：每个阶段有自己的最低验收条件
// （见下方 PHASE_MINIMUMS），不满足就返回 failed，调用方（stream-finalization.ts）据此
// 决定要不要真的把节点标 done。
//
// 范围声明：这是阶段1 的"最低可行验收器"，只用 finalizeStreamedChatTurn 这一层已有的信号
// （harnessDirty / toolCallCount / hasSummary）做判断，不依赖阶段3 才建的证据链模块
// （evidence/ EvidenceRef）——阶段1 的退出标准只要求"不存在'模型说完成了就完成'的路径"，
// 更细的"缺哪条具体证据"留给阶段3 的证据链去做。

import type { WorkflowPhase } from "./types";
import type { NodeOutcome } from "./node-outcome";

export interface VerifyNodeOutcomeInput {
  phase: WorkflowPhase;
  /** 本轮 Harness 是否判定编造（HarnessVerdict.fabricationSuspected 非空）。 */
  harnessDirty: boolean;
  /** 本轮真实工具调用次数。 */
  toolCallCount: number;
  /** 是否有非空回答内容。 */
  hasSummary: boolean;
  /** 模型显式声明"本次无需改动"（execute 阶段允许 0 工具调用通过）。 */
  explicitNoopDeclared?: boolean;
  /** 用户拒绝了写权限确认。 */
  userDeniedPermission?: boolean;
  /** 用户主动中止了这一轮。 */
  controllerAborted?: boolean;
  /** verify 阶段已经自动打回 execute 修复过的次数（WorkflowNode.repairAttempts）。
   *  只对 phase === "verify" 生效，决定 failed 该降级成 retryable 还是升级成 blocked。 */
  repairAttempts?: number;
  artifactIds?: string[];
  toolExecutionIds?: string[];
  evidenceIds?: string[];
}

/** 需要真实工具调用证据才能通过的阶段（对应文档表格里"至少有真实证据"这几档）。 */
const PHASES_REQUIRING_TOOL_EVIDENCE = new Set<WorkflowPhase>(["read_project", "execute", "verify"]);

/** verify 失败后最多自动打回 execute 修复的次数，达到后进入 blocked，不能无限循环。 */
export const MAX_REPAIR_ATTEMPTS = 2;

/**
 * verify 阶段专属：把"failed"降级成受控修复循环的"retryable"，或者在修复次数耗尽后
 * 升级成终态的"blocked"。非 verify 阶段的 failed 原样返回，不进入自动修复。
 */
function applyVerifyRepairLoop(outcome: NodeOutcome, input: VerifyNodeOutcomeInput): NodeOutcome {
  if (input.phase !== "verify" || outcome.status !== "failed") return outcome;

  const attempts = input.repairAttempts ?? 0;
  if (attempts >= MAX_REPAIR_ATTEMPTS) {
    return {
      ...outcome,
      status: "blocked",
      summary: `verify 已自动修复 ${attempts} 次仍未通过，达到上限，需要人工介入。原因：${outcome.summary}`,
      stopReason: "repair_attempts_exhausted",
    };
  }
  return {
    ...outcome,
    status: "retryable",
    retryHint: outcome.retryHint ?? "回到 execute 阶段修复后重新验证。",
  };
}

export function verifyNodeOutcome(input: VerifyNodeOutcomeInput): NodeOutcome {
  const base = {
    evidenceIds: input.evidenceIds ?? [],
    artifactIds: input.artifactIds ?? [],
    toolExecutionIds: input.toolExecutionIds ?? [],
  };

  if (input.controllerAborted) {
    return { ...base, status: "needs_user", summary: "用户主动中止，不判定失败或成功。" };
  }
  if (input.userDeniedPermission) {
    return { ...base, status: "needs_user", summary: "用户拒绝了写权限确认，等待用户下一步指示。" };
  }

  if (input.harnessDirty) {
    return applyVerifyRepairLoop(
      {
        ...base,
        status: "failed",
        summary: "Harness 判定本轮回答存在编造嫌疑，未通过验收。",
        failureCode: "harness_dirty",
        retryHint: "让模型真实调用工具核实后重答，不要凭回忆或推测继续。",
      },
      input,
    );
  }

  if (!input.hasSummary) {
    return applyVerifyRepairLoop(
      { ...base, status: "failed", summary: "本轮没有产出任何回答内容。", failureCode: "empty_output" },
      input,
    );
  }

  const requiresToolEvidence = PHASES_REQUIRING_TOOL_EVIDENCE.has(input.phase);
  const hasToolEvidence = input.toolCallCount > 0 || !!input.explicitNoopDeclared;
  if (requiresToolEvidence && !hasToolEvidence) {
    return applyVerifyRepairLoop(
      {
        ...base,
        status: "failed",
        summary: `阶段 "${input.phase}" 需要真实工具调用证据，本轮 0 次工具调用。`,
        failureCode: "no_tool_evidence",
        retryHint: "调用真实工具（read/write/bash 等）产出证据，不要只在文字里描述已经做过。",
      },
      input,
    );
  }

  return { ...base, status: "passed", summary: "本轮验收通过。" };
}
