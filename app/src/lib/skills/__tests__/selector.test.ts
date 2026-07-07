import { describe, expect, it } from "vitest";
import { createCodeTaskWorkflowSnapshot } from "@/lib/workflow/code-task-template";
import { selectSkillForTurn } from "../selector";

function workflow(currentNodeId: string, executionMode: "answer_only" | "plan_only" | "plan_then_execute" | "execute_directly" = "plan_then_execute") {
  return {
    ...createCodeTaskWorkflowSnapshot({
      runId: "run-1",
      conversationId: "conv-1",
      objective: "工程化收口",
      workspacePath: "/repo",
      executionMode,
    }),
    currentNodeId,
  };
}

describe("selectSkillForTurn", () => {
  it("按当前 workflow 阶段选择项目审计技能", () => {
    const selected = selectSkillForTurn({
      text: "先看一下项目现在有什么问题",
      workflowSnapshot: workflow("read_project"),
    });

    expect(selected).toMatchObject({
      id: "project_audit",
      label: "项目审计",
    });
    expect(selected?.reason).toContain("read_project");
  });

  it("用户要求开始执行时选择按方案执行技能", () => {
    const selected = selectSkillForTurn({
      text: "按桌面那个方案开始执行，不要再博弈",
      workflowSnapshot: workflow("plan", "execute_directly"),
    });

    expect(selected).toMatchObject({
      id: "plan_execution",
      label: "按方案执行",
    });
  });

  it("验证阶段或验证关键词选择验证收口技能", () => {
    expect(selectSkillForTurn({
      text: "跑一下测试和构建验证",
      workflowSnapshot: workflow("execute"),
    })?.id).toBe("verification_closure");

    expect(selectSkillForTurn({
      text: "继续",
      workflowSnapshot: workflow("verify"),
    })?.id).toBe("verification_closure");
  });

  it("纯问答且无命中时不强行启用技能", () => {
    const selected = selectSkillForTurn({
      text: "解释一下这个按钮是什么意思",
      workflowSnapshot: null,
    });

    expect(selected).toBeNull();
  });
});
