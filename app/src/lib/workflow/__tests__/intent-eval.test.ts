import { describe, expect, it } from "vitest";
import { classifyTurnIntentWithJudge } from "../intent-judge";
import { createCodeTaskWorkflowSnapshot } from "../code-task-template";

const activeRun = () =>
  createCodeTaskWorkflowSnapshot({
    runId: "run-eval",
    conversationId: "conv-eval",
    objective: "完成一个项目工作流",
    workspacePath: "/tmp/project",
  });

// 2026-07-04 扩容：意图识别阶段4 eval 集从 6 条扩到 30+ 条，覆盖 11 种 IntentAction
// 的多种自然表达变体（不是简单复制关键词，是同一个意图的不同说法），弥补"规模远小于
// 设想 30-50 条"这条待办。每条断言只检查 action + patch 关键字段是否存在/不存在，
// 不锁定 confidence/reason 具体值——这两条链路（L0 规则 + L1 语义路由）在设计上对同一
// 类意图应该给出一致的最终 action，断言方式跟原有 6 条保持同一种松紧度。
describe("intent routing eval", () => {
  it.each([
    // ===== start_run（无 active run，读项目/交付内容类任务）=====
    {
      text: "全面盘查一遍我们的项目，深入理解，等会儿我要写一篇公众号软文",
      active: null,
      expectedAction: "start_run",
      expectedPatch: "objective",
      forbiddenPatch: "debateRequested",
    },
    {
      text: "帮我读一下这个仓库的代码，深入理解一下整体架构",
      active: null,
      expectedAction: "start_run",
      expectedPatch: "objective",
      forbiddenPatch: "debateRequested",
    },
    {
      text: "先扫一遍这个工程，了解已经实现了哪些功能",
      active: null,
      expectedAction: "start_run",
      expectedPatch: "objective",
      forbiddenPatch: "debateRequested",
    },

    // ===== start_run（无 active run，方案/计划类）=====
    {
      text: "给我一份完整的落地方案和迭代路线图",
      active: null,
      expectedAction: "start_run",
      expectedPatch: "executionMode",
      forbiddenPatch: "debateRequested",
    },

    // ===== review（continue_run + reviewRequested，有 active run）=====
    {
      text: "好，那你让另外一个 AI 来评估一下这个方案",
      active: activeRun(),
      expectedAction: "continue_run",
      expectedPatch: "reviewRequested",
      forbiddenPatch: "debateRequested",
    },
    {
      text: "找个审查者帮我复核一下，挑挑漏洞",
      active: activeRun(),
      expectedAction: "continue_run",
      expectedPatch: "reviewRequested",
      forbiddenPatch: "debateRequested",
    },

    // ===== debate（continue_run + debateRequested，有 active run）=====
    {
      text: "让几个模型分别站不同立场互相反驳，最后给一个裁判结论",
      active: activeRun(),
      expectedAction: "continue_run",
      expectedPatch: "debateRequested",
      forbiddenPatch: "reviewRequested",
    },
    {
      text: "开个 PK 吧，两个方案对着打一场，最后裁判选一个",
      active: activeRun(),
      expectedAction: "continue_run",
      expectedPatch: "debateRequested",
      forbiddenPatch: "reviewRequested",
    },

    // ===== answer_only（纯聊天/润色，有 active run 但不该推进工作流）=====
    {
      text: "这篇软文推得太硬了，改得自然一点",
      active: activeRun(),
      expectedAction: "answer_only",
      expectedPatch: null,
      forbiddenPatch: "debateRequested",
    },
    {
      text: "解释一下这是什么意思",
      active: null,
      expectedAction: "answer_only",
      expectedPatch: null,
      forbiddenPatch: "debateRequested",
    },

    // ===== execute（approve_node，有 active run）=====
    {
      text: "按这个方案开始改代码",
      active: activeRun(),
      expectedAction: "approve_node",
      expectedPatch: "executionMode",
      forbiddenPatch: "debateRequested",
    },
    {
      text: "直接执行这个方案，落地实现吧",
      active: activeRun(),
      expectedAction: "approve_node",
      expectedPatch: "executionMode",
      forbiddenPatch: "debateRequested",
    },

    // ===== execute（无 active run，需先建立任务上下文）=====
    {
      text: "直接把这个功能实现出来",
      active: null,
      expectedAction: "start_run",
      expectedPatch: "executionMode",
      forbiddenPatch: "debateRequested",
    },

    // ===== verify（continue_run + verificationRequired，有 active run）=====
    {
      text: "跑一下测试看看有没有问题",
      active: activeRun(),
      expectedAction: "continue_run",
      expectedPatch: "verificationRequired",
      forbiddenPatch: "debateRequested",
    },
    {
      text: "构建一下，确认能不能通过",
      active: activeRun(),
      expectedAction: "continue_run",
      expectedPatch: "verificationRequired",
      forbiddenPatch: "debateRequested",
    },

    // ===== reject_node（打回当前结果，需要 active run）=====
    {
      text: "不对，这不是我想要的，重来",
      active: activeRun(),
      expectedAction: "reject_node",
      expectedPatch: null,
      forbiddenPatch: "debateRequested",
    },
    {
      text: "打回，这个方案不行，改一下",
      active: activeRun(),
      expectedAction: "reject_node",
      expectedPatch: null,
      forbiddenPatch: "debateRequested",
    },

    // ===== pause_run（硬规则，L0 直接判，不需要 active run）=====
    {
      text: "先暂停一下，我想想",
      active: activeRun(),
      expectedAction: "pause_run",
      expectedPatch: null,
      forbiddenPatch: "debateRequested",
    },
    {
      text: "等一下，先别继续",
      active: null,
      expectedAction: "pause_run",
      expectedPatch: null,
      forbiddenPatch: "debateRequested",
    },

    // ===== cancel_run（硬规则，L0 直接判，不需要 active run）=====
    {
      text: "算了，取消这个任务吧",
      active: activeRun(),
      expectedAction: "cancel_run",
      expectedPatch: null,
      forbiddenPatch: "debateRequested",
    },
    {
      text: "不要继续了，直接停止这个任务",
      active: null,
      expectedAction: "cancel_run",
      expectedPatch: null,
      forbiddenPatch: "debateRequested",
    },

    // ===== continue_run（单纯"继续"，有 active run 且只有一个候选下一步）=====
    {
      text: "继续吧",
      active: activeRun(),
      expectedAction: "continue_run",
      expectedPatch: null,
      forbiddenPatch: "debateRequested",
    },
    {
      text: "下一步",
      active: activeRun(),
      expectedAction: "continue_run",
      expectedPatch: null,
      forbiddenPatch: "debateRequested",
    },

    // ===== plan（有 active run，continue_run + executionMode=plan_only）=====
    {
      text: "帮我重新规划一下这个方案的整体架构",
      active: activeRun(),
      expectedAction: "continue_run",
      expectedPatch: "executionMode",
      forbiddenPatch: "debateRequested",
    },
    {
      text: "麻烦帮我设计一份迭代路线图",
      active: activeRun(),
      expectedAction: "continue_run",
      expectedPatch: "executionMode",
      forbiddenPatch: "debateRequested",
    },

    // ===== 英文表达变体（覆盖非中文用户的常见说法）=====
    {
      text: "go on",
      active: activeRun(),
      expectedAction: "continue_run",
      expectedPatch: null,
      forbiddenPatch: "debateRequested",
    },
    {
      text: "cancel this task",
      active: activeRun(),
      expectedAction: "cancel_run",
      expectedPatch: null,
      forbiddenPatch: "debateRequested",
    },
    {
      text: "please pause for a moment",
      active: null,
      expectedAction: "pause_run",
      expectedPatch: null,
      forbiddenPatch: "debateRequested",
    },

    // ===== 更口语化的表达变体 =====
    {
      text: "这个不对，不是我要的效果，麻烦重来一下",
      active: activeRun(),
      expectedAction: "reject_node",
      expectedPatch: null,
      forbiddenPatch: "debateRequested",
    },
    {
      text: "麻烦另一个模型帮忙看看这个方案靠不靠谱",
      active: activeRun(),
      expectedAction: "continue_run",
      expectedPatch: "reviewRequested",
      forbiddenPatch: "debateRequested",
    },
    {
      text: "跑一下 build，看能不能过",
      active: activeRun(),
      expectedAction: "continue_run",
      expectedPatch: "verificationRequired",
      forbiddenPatch: "debateRequested",
    },
    {
      text: "照这个方案开始修复吧",
      active: activeRun(),
      expectedAction: "approve_node",
      expectedPatch: "executionMode",
      forbiddenPatch: "debateRequested",
    },
    {
      text: "帮我了解一下这个工程目前实现到什么程度了",
      active: null,
      expectedAction: "start_run",
      expectedPatch: "objective",
      forbiddenPatch: "debateRequested",
    },
  ])("$text", async ({ text, active, expectedAction, expectedPatch, forbiddenPatch }) => {
    const decision = await classifyTurnIntentWithJudge({
      text,
      activeRun: active,
      model: null,
    });

    expect(decision.action).toBe(expectedAction);
    if (expectedPatch) expect(decision.patch).toHaveProperty(expectedPatch);
    if (forbiddenPatch) expect(decision.patch?.[forbiddenPatch as keyof typeof decision.patch]).not.toBe(true);
  });
});
