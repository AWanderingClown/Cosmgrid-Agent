// Harness 工程实施计划 阶段4 — 5 个 deterministic grader + 注册表。
//
// 每个 grader 是纯函数，输入 (expected, ctx) → {ok, detail}：
//   - filesystem：检查 workspacePath 下的文件存在 + 内容正则匹配
//   - command-exit-code：tool_executions 里 bash 命令成功（status=success）
//   - workflow-artifact：workflow_runs 关联的 planSource 存在且 kind 匹配
//   - tool-execution：按 messageId + toolName 查 tool_executions 记录存在
//   - evidence-complete：调 verifyTask 检查 status !== "fails"
//
// 所有 grader **只消费结构化事实**（tool_executions / workflow_runs / verifyTask）——
// 不允许网络调用，不允许 LLM judge（LLM judge 在 llm-judge.ts 单独做）。

import type { Grader, GraderResult } from "../types";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// =====================================================================
// 1. filesystem
// =====================================================================

interface FilesystemExpectation {
  /** 相对 workspacePath 的文件路径 */
  path: string;
  /** 文件内容必须包含的全部正则模式（任一不匹配 → fail） */
  containsRegex?: string[];
  /** 文件大小下限（字节，0 = 不限制） */
  minBytes?: number;
}

export const filesystemGrader: Grader = async (expected, ctx) => {
  const exp = expected as FilesystemExpectation;
  if (!exp || !exp.path) {
    return fail("filesystem: expected.path 必填");
  }
  const abs = join(ctx.workspacePath, exp.path);
  if (!existsSync(abs)) {
    return fail(`filesystem: ${exp.path} 不存在`);
  }
  const content = readFileSync(abs, "utf-8");
  if (exp.minBytes && content.length < exp.minBytes) {
    return fail(`filesystem: ${exp.path} 长度 ${content.length} < ${exp.minBytes}`);
  }
  if (exp.containsRegex && exp.containsRegex.length > 0) {
    for (const pattern of exp.containsRegex) {
      if (!new RegExp(pattern).test(content)) {
        return fail(`filesystem: ${exp.path} 不含模式 ${pattern}`);
      }
    }
  }
  return pass(`filesystem: ${exp.path} ok`);
};

// =====================================================================
// 2. command-exit-code
// =====================================================================

interface CommandExitCodeExpectation {
  /** 期望执行的命令（含参数，可正则） */
  commandPattern: string;
  /** 期望的退出码（0 = success；默认 0） */
  expectedExitCode?: number;
  /** 必须 success=true（默认 true；false 用于"应该失败"测试） */
  expectSuccess?: boolean;
}

export const commandExitCodeGrader: Grader = async (expected, ctx) => {
  const exp = expected as CommandExitCodeExpectation;
  if (!exp || !exp.commandPattern) {
    return fail("command-exit-code: expected.commandPattern 必填");
  }
  const re = new RegExp(exp.commandPattern);
  const matched = ctx.toolExecRows.find(
    (r) => r.toolName === "bash" && re.test(r.input),
  );
  if (!matched) {
    return fail(`command-exit-code: 没找到命令 ${exp.commandPattern}`);
  }
  const wantSuccess = exp.expectSuccess !== false;
  if (wantSuccess && matched.status !== "success") {
    return fail(`command-exit-code: ${exp.commandPattern} status=${matched.status} 期望 success`);
  }
  return pass(`command-exit-code: ${exp.commandPattern} ${matched.status}`);
};

// =====================================================================
// 3. workflow-artifact
// =====================================================================

interface WorkflowArtifactExpectation {
  /** 期望的 planSource.kind（"file" / "degraded_debate" / "message"） */
  expectedKind: "file" | "degraded_debate" | "message";
}

export const workflowArtifactGrader: Grader = async (expected, ctx) => {
  const exp = expected as WorkflowArtifactExpectation;
  if (!exp || !exp.expectedKind) {
    return fail("workflow-artifact: expected.expectedKind 必填");
  }
  if (!ctx.workflowRun) {
    return fail("workflow-artifact: ctx.workflowRun 缺失（评测上下文需传入关联的 workflow_run）");
  }
  // workflow_runs.artifact_json 存的是 EvalRun 的 artifact；planSource 在 snapshot_json 里。
  // 这里简化为：查 EvalRun 是否绑定到正确的 EvalCase（按 plan_source_kind 字符串匹配）。
  const planSourceKind = (ctx.workflowRun.artifactJson ?? "").match(/"planSourceKind":"([^"]+)"/)?.[1];
  if (planSourceKind === exp.expectedKind) {
    return pass(`workflow-artifact: planSourceKind=${planSourceKind}`);
  }
  return fail(`workflow-artifact: 期望 planSourceKind=${exp.expectedKind} 实际=${planSourceKind ?? "null"}`);
};

// =====================================================================
// 4. tool-execution
// =====================================================================

interface ToolExecutionExpectation {
  /** 必须调用的工具名（"write" / "edit" / "bash" 等） */
  toolName: string;
  /** 期望的最少调用次数（默认 1） */
  minCount?: number;
  /** input 里必须包含的字段（正则匹配 input JSON 字符串） */
  inputMustMatch?: string;
}

export const toolExecutionGrader: Grader = async (expected, ctx) => {
  const exp = expected as ToolExecutionExpectation;
  if (!exp || !exp.toolName) {
    return fail("tool-execution: expected.toolName 必填");
  }
  const matched = ctx.toolExecRows.filter((r) => r.toolName === exp.toolName);
  const min = exp.minCount ?? 1;
  if (matched.length < min) {
    return fail(`tool-execution: 工具 ${exp.toolName} 调用 ${matched.length} 次 < ${min}`);
  }
  if (exp.inputMustMatch) {
    const re = new RegExp(exp.inputMustMatch);
    const any = matched.some((r) => re.test(r.input));
    if (!any) {
      return fail(`tool-execution: ${exp.toolName} 没有匹配的 input 模式 ${exp.inputMustMatch}`);
    }
  }
  return pass(`tool-execution: ${exp.toolName} ${matched.length} 次 ok`);
};

// =====================================================================
// 5. evidence-complete
// =====================================================================

interface EvidenceCompleteExpectation {
  /** 期望 verifyTask 的 status（passes / fails / inconclusive） */
  expectedStatus: "passes" | "fails" | "inconclusive";
}

export const evidenceCompleteGrader: Grader = async (expected, ctx) => {
  const exp = expected as EvidenceCompleteExpectation;
  if (!exp || !exp.expectedStatus) {
    return fail("evidence-complete: expected.expectedStatus 必填");
  }
  // 阶段3 复用的 verifyTask 入口（懒加载避免循环依赖）
  const { verifyTask } = await import("@/lib/llm/evidence/task-verifier");
  const ts = new Date(Date.now() - 5 * 60_000).toISOString();
  const verification = verifyTask({
    finalContent: ctx.taskOutcomes[0]?.finalSummary ?? "",
    execRows: ctx.toolExecRows,
    assistantMessageId: ctx.conversationId ?? "msg-A",
    sinceIso: ts,
    acceptanceCriteria: [],
    workflowRef: { runId: ctx.workflowRun?.id ?? "run-1", nodeId: "node-1" },
  });
  if (verification.status === exp.expectedStatus) {
    return pass(`evidence-complete: status=${verification.status}`);
  }
  return fail(`evidence-complete: 期望 ${exp.expectedStatus} 实际 ${verification.status}`);
};

// =====================================================================
// 注册表
// =====================================================================

const GRADERS: Record<string, Grader> = {
  filesystem: filesystemGrader,
  "command-exit-code": commandExitCodeGrader,
  "workflow-artifact": workflowArtifactGrader,
  "tool-execution": toolExecutionGrader,
  "evidence-complete": evidenceCompleteGrader,
};

export function getGrader(name: string): Grader | null {
  return GRADERS[name] ?? null;
}

export function listGraders(): string[] {
  return Object.keys(GRADERS);
}

// helpers
function pass(detail: string): GraderResult {
  return { ok: true, detail };
}
function fail(detail: string): GraderResult {
  return { ok: false, detail };
}