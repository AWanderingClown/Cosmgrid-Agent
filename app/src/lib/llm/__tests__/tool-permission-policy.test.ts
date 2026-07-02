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

describe("shouldExposeWriteTools", () => {
  it("读项目并写公众号软文，只给只读工具，不暴露 bash/write/edit", () => {
    expect(shouldExposeWriteTools({
      text: "全面盘查项目，理解产品意图，等会儿写一篇公众号软文推广",
      permissionMode: "confirm",
      decision: decision({ action: "continue_run" }),
    })).toBe(false);
  });

  it("只读权限档永远不暴露写/执行工具", () => {
    expect(shouldExposeWriteTools({
      text: "修复这个 bug 并跑测试",
      permissionMode: "read",
      decision: decision({ action: "approve_node" }),
    })).toBe(false);
  });

  it("明确改代码、创建文件、跑测试时暴露写/执行工具", () => {
    expect(shouldExposeWriteTools({
      text: "修复这个 bug 并跑测试",
      permissionMode: "confirm",
      decision: decision(),
    })).toBe(true);

    expect(shouldExposeWriteTools({
      text: "创建文件并保存到桌面",
      permissionMode: "auto",
      decision: decision(),
    })).toBe(true);
  });

  it("工作流明确进入执行阶段时暴露写/执行工具", () => {
    expect(shouldExposeWriteTools({
      text: "继续",
      permissionMode: "confirm",
      decision: decision({ action: "approve_node", patch: { executionMode: "execute_directly" } }),
    })).toBe(true);
  });
});

// V2 修复（2026-07-02）：impliesWriteIntent 是 shouldExposeWriteTools 拆出来的、
// 不看 permissionMode 的版本，专门给 ChatPage 判断"消息想写但没给工具"这个场景用。
describe("impliesWriteIntent", () => {
  it("明确改代码/创建文件等意图 → true（不受 permissionMode 影响，这个函数根本不看它）", () => {
    expect(impliesWriteIntent({ text: "修复这个 bug 并跑测试", decision: decision() })).toBe(true);
    expect(impliesWriteIntent({ text: "创建文件并保存到桌面", decision: decision() })).toBe(true);
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
});
