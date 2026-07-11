// Harness 阶段4 — 5 个 deterministic grader 单测。
//
// 每个 grader 1 happy + 1 fail（覆盖核心判断路径 + 错误信息格式）。

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filesystemGrader, commandExitCodeGrader, workflowArtifactGrader,
  toolExecutionGrader, evidenceCompleteGrader,
} from "../graders";
import type { TaskOutcomeRow, EvalRunRow, ToolExecutionRow } from "@/lib/db";

function makeTmpWs(): string {
  return mkdtempSync(join(tmpdir(), "evals-test-"));
}

function rowOf(over: Partial<ToolExecutionRow>): ToolExecutionRow {
  return {
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    projectId: null,
    conversationId: "c1",
    messageId: "m1",
    toolName: "write",
    input: "{}",
    output: "",
    status: "success",
    userConfirmed: false,
    reversible: false,
    durationMs: 0,
    createdAt: "2026-07-11T00:00:00.000Z",
    resultJson: null,
    errorCode: null,
    ...over,
  };
}

function evalRunOf(over: Partial<EvalRunRow>): EvalRunRow {
  return {
    id: "run-1",
    harnessVersion: "v1",
    modelId: "m1",
    taskSetId: "held-in",
    startedAt: "2026-07-11T00:00:00.000Z",
    finishedAt: null,
    totalCostUsd: 0,
    retryCount: 0,
    status: "running",
    artifactJson: null,
    failureKindsJson: null,
    createdAt: "2026-07-11T00:00:00.000Z",
    ...over,
  };
}

function taskOutcomeOf(over: Partial<TaskOutcomeRow>): TaskOutcomeRow {
  return {
    id: "to-1",
    conversationId: "c1",
    nodeId: null,
    outcome: "passed",
    finalSummary: null,
    interventionKind: null,
    evidenceRefsJson: null,
    createdAt: "2026-07-11T00:00:00.000Z",
    ...over,
  };
}

describe("graders: filesystem", () => {
  it("happy: 文件存在 + 内容匹配", async () => {
    const ws = makeTmpWs();
    try {
      writeFileSync(join(ws, "hello.ts"), "export const x = 1;\n");
      const r = await filesystemGrader(
        { path: "hello.ts", containsRegex: ["export const x = 1"] },
        { caseId: "c", workspacePath: ws, toolExecRows: [], taskOutcomes: [], budgetUsedUsd: 0, budgetTotalUsd: 1 },
      );
      expect(r.ok).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("fail: 文件不存在", async () => {
    const ws = makeTmpWs();
    try {
      const r = await filesystemGrader(
        { path: "missing.ts" },
        { caseId: "c", workspacePath: ws, toolExecRows: [], taskOutcomes: [], budgetUsedUsd: 0, budgetTotalUsd: 1 },
      );
      expect(r.ok).toBe(false);
      expect(r.detail).toContain("不存在");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("graders: command-exit-code", () => {
  it("happy: bash 记录 success", async () => {
    const r = await commandExitCodeGrader(
      { commandPattern: "pnpm test" },
      {
        caseId: "c", workspacePath: "/tmp", toolExecRows: [
          rowOf({ toolName: "bash", input: JSON.stringify({ command: "pnpm test" }), status: "success" }),
        ], taskOutcomes: [], budgetUsedUsd: 0, budgetTotalUsd: 1,
      },
    );
    expect(r.ok).toBe(true);
  });

  it("fail: bash 记录 error", async () => {
    const r = await commandExitCodeGrader(
      { commandPattern: "pnpm build" },
      {
        caseId: "c", workspacePath: "/tmp", toolExecRows: [
          rowOf({ toolName: "bash", input: JSON.stringify({ command: "pnpm build" }), status: "error" }),
        ], taskOutcomes: [], budgetUsedUsd: 0, budgetTotalUsd: 1,
      },
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("status=error");
  });
});

describe("graders: workflow-artifact", () => {
  it("happy: planSourceKind 匹配", async () => {
    const r = await workflowArtifactGrader(
      { expectedKind: "file" },
      {
        caseId: "c", workspacePath: "/tmp", toolExecRows: [],
        workflowRun: evalRunOf({ artifactJson: '{"planSourceKind":"file","planSourcePath":"docs/plan.md"}' }),
        taskOutcomes: [], budgetUsedUsd: 0, budgetTotalUsd: 1,
      },
    );
    expect(r.ok).toBe(true);
  });

  it("fail: planSourceKind 不匹配", async () => {
    const r = await workflowArtifactGrader(
      { expectedKind: "file" },
      {
        caseId: "c", workspacePath: "/tmp", toolExecRows: [],
        workflowRun: evalRunOf({ artifactJson: '{"planSourceKind":"message"}' }),
        taskOutcomes: [], budgetUsedUsd: 0, budgetTotalUsd: 1,
      },
    );
    expect(r.ok).toBe(false);
  });
});

describe("graders: tool-execution", () => {
  it("happy: 工具调用 1 次", async () => {
    const r = await toolExecutionGrader(
      { toolName: "write" },
      {
        caseId: "c", workspacePath: "/tmp",
        toolExecRows: [rowOf({ toolName: "write", input: JSON.stringify({ file_path: "foo.ts" }) })],
        taskOutcomes: [], budgetUsedUsd: 0, budgetTotalUsd: 1,
      },
    );
    expect(r.ok).toBe(true);
  });

  it("fail: 工具调用 0 次", async () => {
    const r = await toolExecutionGrader(
      { toolName: "write" },
      {
        caseId: "c", workspacePath: "/tmp", toolExecRows: [],
        taskOutcomes: [], budgetUsedUsd: 0, budgetTotalUsd: 1,
      },
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("调用 0 次");
  });

  it("input 模式匹配: 命中", async () => {
    const r = await toolExecutionGrader(
      { toolName: "bash", inputMustMatch: "pnpm" },
      {
        caseId: "c", workspacePath: "/tmp",
        toolExecRows: [rowOf({ toolName: "bash", input: JSON.stringify({ command: "pnpm test" }) })],
        taskOutcomes: [], budgetUsedUsd: 0, budgetTotalUsd: 1,
      },
    );
    expect(r.ok).toBe(true);
  });
});

describe("graders: evidence-complete", () => {
  it("happy: insufficient claim 触发 inconclusive status", async () => {
    // finalContent 包含"我修改了 foo.ts"但 toolExecRows 无 write 记录 → verifyTask 报 inconclusive
    const r = await evidenceCompleteGrader(
      { expectedStatus: "inconclusive" },
      {
        caseId: "c", workspacePath: "/tmp",
        toolExecRows: [rowOf({ toolName: "read", input: JSON.stringify({ file_path: "foo.ts" }) })],
        taskOutcomes: [taskOutcomeOf({ finalSummary: "我修改了 foo.ts" })],
        budgetUsedUsd: 0, budgetTotalUsd: 1,
      },
    );
    expect(r.ok).toBe(true);
  });

  it("fail: 期望 passes 实际 inconclusive", async () => {
    const r = await evidenceCompleteGrader(
      { expectedStatus: "passes" },
      {
        caseId: "c", workspacePath: "/tmp",
        toolExecRows: [],
        taskOutcomes: [taskOutcomeOf({ finalSummary: "我修改了 foo.ts" })],
        budgetUsedUsd: 0, budgetTotalUsd: 1,
      },
    );
    expect(r.ok).toBe(false);
  });
});