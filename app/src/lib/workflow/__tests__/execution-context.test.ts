import { describe, expect, it } from "vitest";
import type { FsAdapter } from "@/lib/llm/tools/fs-adapter";
import { createCodeTaskWorkflowSnapshot } from "../code-task-template";
import { applyTurnIntentDecision, attachPlanSourceToWorkflow, completeCurrentWorkflowNode } from "../reducer";
import { buildWorkflowContextPreamble, readDesktopPlanForExecution } from "../execution-context";

function fakeFs(files: Record<string, string>): FsAdapter {
  return {
    exists: async (path) => path in files,
    readTextFile: async (path) => {
      if (path in files) return files[path]!;
      throw new Error(`ENOENT: ${path}`);
    },
    readDir: async () => [],
    writeTextFile: async () => {},
    mkdirp: async () => {},
  };
}

function workflow() {
  return createCodeTaskWorkflowSnapshot({
    runId: "run-1",
    conversationId: "conv-1",
    objective: "修复交易 App Demo",
    workspacePath: "/project",
  });
}

describe("workflow execution context", () => {
  it("用户引用桌面方案时读取 Desktop/PLAN.md", async () => {
    const plan = await readDesktopPlanForExecution({
      userText: "这个方案可以，开始执行",
      desktopPath: "/Users/me/Desktop",
      fs: fakeFs({ "/Users/me/Desktop/PLAN.md": "# 方案\nPhase 1" }),
    });

    expect(plan?.path).toBe("/Users/me/Desktop/PLAN.md");
    expect(plan?.content).toContain("Phase 1");
  });

  it("没有引用既定方案时不主动读取桌面 PLAN", async () => {
    const plan = await readDesktopPlanForExecution({
      userText: "解释一下这个页面",
      desktopPath: "/Users/me/Desktop",
      fs: fakeFs({ "/Users/me/Desktop/PLAN.md": "# 方案" }),
    });

    expect(plan).toBeNull();
  });

  it("把 workflow 目标、阶段、方案来源和桌面方案内容注入为系统事实", () => {
    const planned = completeCurrentWorkflowNode({ snapshot: workflow(), summary: "项目摘要" });
    const planNode = applyTurnIntentDecision({
      snapshot: planned,
      decision: {
        action: "continue_run",
        targetRunId: "run-1",
        confidence: 0.9,
        reason: "test",
        evidenceTurnIds: [],
      },
    });
    const withPlan = completeCurrentWorkflowNode({ snapshot: planNode, summary: "先做工作流可靠性收口" });
    const execute = applyTurnIntentDecision({
      snapshot: withPlan,
      decision: {
        action: "approve_node",
        targetRunId: "run-1",
        confidence: 0.9,
        reason: "test",
        evidenceTurnIds: [],
        patch: { executionMode: "execute_directly", debateRequested: false, reviewRequested: false },
      },
    });
    const preamble = buildWorkflowContextPreamble({
      snapshot: execute,
      userText: "开始执行",
      desktopPlan: { path: "/Users/me/Desktop/PLAN.md", content: "桌面方案正文" },
    });

    expect(preamble).toContain("当前工作流上下文");
    expect(preamble).toContain("修复交易 App Demo");
    expect(preamble).toContain("当前阶段：execute");
    expect(preamble).toContain("先做工作流可靠性收口");
    expect(preamble).toContain("/Users/me/Desktop/PLAN.md");
    expect(preamble).toContain("桌面方案正文");
    expect(preamble).toContain("不要每个阶段都停下来等用户确认");
  });

  it("桌面方案读取后可绑定回 workflow，重启恢复时仍有方案来源", () => {
    const attached = attachPlanSourceToWorkflow({
      snapshot: workflow(),
      summary: "桌面 PLAN 摘要",
      source: {
        kind: "file",
        ref: "/Users/me/Desktop/PLAN.md",
        summary: "桌面 PLAN 摘要",
        phase: "plan",
        boundAt: "2026-07-07T00:00:00.000Z",
        label: "用户桌面方案文件",
      },
    });

    expect(attached.context.planSummary).toBe("桌面 PLAN 摘要");
    expect(attached.context.planSource?.kind).toBe("file");
    expect(attached.context.planSource?.ref).toBe("/Users/me/Desktop/PLAN.md");
  });
});
