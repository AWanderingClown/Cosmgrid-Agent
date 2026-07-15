import { describe, expect, it } from "vitest";
import { createCodeTaskWorkflowSnapshot } from "@/lib/workflow/code-task-template";
import { selectSkillForTurn } from "../selector";
import type { SkillDefinition } from "../types";

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

// 2026-07-14 步骤2（skill/workflow 解耦）：project_audit/plan_execution/verification_closure
// 这 3 个内置 id 的阶段行为纪律已迁移进 lib/workflow/phase-guidance.ts，selector 不再选择它们
// （否则会跟 workflowPreamble 重复注入同一段内容）。下面这组测试改成验证"即使 phase/keyword/
// intent 命中，也不会选出这 3 个退休 id"，并额外验证真 skill（非退休 id）仍能被正常选中。
describe("selectSkillForTurn", () => {
  it("phase=read_project 命中审计关键词，也不再选出已退休的 project_audit", () => {
    const selected = selectSkillForTurn({
      text: "先看一下项目现在有什么问题",
      workflowSnapshot: workflow("read_project"),
    });
    expect(selected).toBeNull();
  });

  it("phase=execute + execute_directly 命中，也不再选出已退休的 plan_execution", () => {
    const selected = selectSkillForTurn({
      text: "按桌面那个方案开始执行，不要再博弈",
      workflowSnapshot: workflow("plan", "execute_directly"),
    });
    expect(selected).toBeNull();
  });

  it("phase=verify / 验证关键词命中，也不再选出已退休的 verification_closure", () => {
    expect(
      selectSkillForTurn({
        text: "跑一下测试和构建验证",
        workflowSnapshot: workflow("execute"),
      }),
    ).toBeNull();

    expect(
      selectSkillForTurn({
        text: "继续",
        workflowSnapshot: workflow("verify"),
      }),
    ).toBeNull();
  });

  it("意图裁判判定 execute，也不再选出已退休的 plan_execution", () => {
    const selected = selectSkillForTurn({
      text: "可以了，动手吧",
      workflowSnapshot: workflow("plan"),
      intentDecision: {
        action: "approve_node",
        targetRunId: "run-1",
        confidence: 0.91,
        reason: "用户要求进入实现。",
        evidenceTurnIds: [],
        patch: { executionMode: "execute_directly", reviewRequested: false, debateRequested: false },
      },
    });
    expect(selected).toBeNull();
  });

  it("语义路由判定 verify，也不再选出已退休的 verification_closure", () => {
    const selected = selectSkillForTurn({
      text: "确认一下刚才改动稳不稳",
      workflowSnapshot: workflow("plan"),
      semanticRoute: {
        top: {
          action: "verify",
          score: 0.82,
          margin: 0.2,
          matchedExample: {
            id: "verify-1",
            action: "verify",
            text: "检查刚才的改动",
            explanation: "用户要求验证结果。",
            source: "builtin",
            weight: 1,
            enabled: true,
          },
        },
        candidates: [],
        confidence: 0.82,
        noMatch: false,
      },
    });
    expect(selected).toBeNull();
  });

  it("纯问答且无命中时不强行启用技能", () => {
    const selected = selectSkillForTurn({
      text: "解释一下这个按钮是什么意思",
      workflowSnapshot: null,
    });
    expect(selected).toBeNull();
  });

  it("真 skill（非退休 id）传入 activeSkills 时，phase 匹配仍能正常选中", () => {
    const realSkill: SkillDefinition = {
      id: "security_review",
      label: "安全审查",
      purpose: "对改动做安全审查",
      triggerPhases: ["verify"],
      triggerKeywords: ["安全"],
      requiredCapabilities: ["read_files"],
      systemGuidance: ["先看认证与输入处理边界。"],
      acceptanceCriteria: ["列出高危项。"],
      source: "user",
      reviewStatus: "approved",
    };
    const selected = selectSkillForTurn({
      text: "继续",
      workflowSnapshot: workflow("verify"),
      activeSkills: [realSkill],
    });
    expect(selected).toMatchObject({ id: "security_review", label: "安全审查" });
  });

  it("退休 id 混在 activeSkills 里也照样被挡住，不影响其它真 skill 正常选中", () => {
    const retiredLike: SkillDefinition = {
      id: "project_audit",
      label: "项目审计（历史）",
      purpose: "历史遗留",
      triggerPhases: ["read_project"],
      triggerKeywords: ["审计"],
      requiredCapabilities: ["read_files"],
      systemGuidance: [],
      acceptanceCriteria: [],
      source: "builtin",
      reviewStatus: "approved",
    };
    const realSkill: SkillDefinition = {
      id: "docs_writer",
      label: "写文档",
      purpose: "生成项目文档",
      triggerPhases: ["read_project"],
      triggerKeywords: ["写文档"],
      requiredCapabilities: ["read_files"],
      systemGuidance: ["先读代码再写文档。"],
      acceptanceCriteria: ["文档覆盖主要模块。"],
      source: "user",
      reviewStatus: "approved",
    };
    const selected = selectSkillForTurn({
      text: "帮我看看项目",
      workflowSnapshot: workflow("read_project"),
      activeSkills: [retiredLike, realSkill],
    });
    expect(selected).toMatchObject({ id: "docs_writer" });
  });
});
