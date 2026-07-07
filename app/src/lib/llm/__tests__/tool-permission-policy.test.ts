import { describe, expect, it } from "vitest";
import { shouldExposeWriteTools, impliesWriteIntent } from "../tool-permission-policy";
import type { TurnIntentDecision } from "@/lib/workflow/types";

function decision(overrides: Partial<TurnIntentDecision> = {}): TurnIntentDecision {
  return {
    action: "answer_only",
    targetRunId: null,
    confidence: 0.8,
    reason: "test",
    evidenceTurnIds: [],
    ...overrides,
  };
}

// 2026-07-04 修复：原来 confirm/auto 档位下还要 impliesWriteIntent 关键词命中才给写工具，
// 但关键词覆盖不了所有口语表达（真实复现：用户权限选了"确认写"，说"保存成一份文件"没命中
// "保存到"，工具压根没给，AI 只能如实说自己没有写工具）。跟用户确认后改成只看权限档位本身：
// confirm 档位下游有 requestConfirm 真人弹窗兜底，auto 档位有命令黑名单+工作区边界兜底，
// 意图判断在两个档位都不再需要，只有 read 档位继续不给。
describe("shouldExposeWriteTools（只看权限档位，不再猜意图）", () => {
  it("read 档位不暴露写/执行工具", () => {
    expect(shouldExposeWriteTools("read")).toBe(false);
  });

  it("confirm 档位无条件暴露写/执行工具（不管这句话是不是软文/闲聊，安全交给下游真人确认）", () => {
    expect(shouldExposeWriteTools("confirm")).toBe(true);
  });

  it("auto 档位无条件暴露写/执行工具（安全交给命令黑名单+工作区边界兜底）", () => {
    expect(shouldExposeWriteTools("auto")).toBe(true);
  });
});

// V2 修复（2026-07-02）：impliesWriteIntent 是 shouldExposeWriteTools 拆出来的、
// 不看 permissionMode 的版本，专门给 ChatPage 判断"消息想写但没给工具"这个场景用。
describe("impliesWriteIntent", () => {
  it("明确改代码/创建文件等意图 → true（不受 permissionMode 影响，这个函数根本不看它）", () => {
    expect(impliesWriteIntent({ text: "修复这个 bug 并跑测试", decision: decision() })).toBe(true);
    expect(impliesWriteIntent({ text: "创建文件并保存到桌面", decision: decision() })).toBe(true);
  });

  it("只要求构建/验证也识别为需要执行工具，不能让模型纯文字说通过", () => {
    expect(impliesWriteIntent({ text: "构建一下，确认能不能通过", decision: decision() })).toBe(true);
    expect(impliesWriteIntent({ text: "跑一下 typecheck 和 lint", decision: decision() })).toBe(true);
  });

  it("纯讨论/软文类意图 → false", () => {
    expect(
      impliesWriteIntent({
        text: "全面盘查项目，理解产品意图，等会儿写一篇公众号软文推广",
        decision: decision({ action: "continue_run" }),
      }),
    ).toBe(false);
    expect(impliesWriteIntent({ text: "今天天气怎么样", decision: decision() })).toBe(false);
  });

  it("工作流明确进入执行阶段 → true", () => {
    expect(
      impliesWriteIntent({
        text: "继续",
        decision: decision({ action: "approve_node", patch: { executionMode: "execute_directly" } }),
      }),
    ).toBe(true);
  });

  // 2026-07-04 修复：真实复现场景——用户口语化说"做一个文件"，原正则只认"新建文件/创建文件"漏检
  it("口语化的'做/弄/建/生成 + 文件'也要识别为写意图（原正则只认书面词漏检过）", () => {
    expect(impliesWriteIntent({ text: "给我做一个点md文件到桌面", decision: decision() })).toBe(true);
    expect(impliesWriteIntent({ text: "帮我弄个文件出来", decision: decision() })).toBe(true);
    expect(impliesWriteIntent({ text: "建一个笔记文件", decision: decision() })).toBe(true);
    expect(impliesWriteIntent({ text: "生成一份总结文件", decision: decision() })).toBe(true);
  });
});
