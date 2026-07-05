import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import {
  applyChainHarnessWarnings,
  buildChainPath,
  completeChainRoleMessage,
  createChainFinishMessage,
  createChainRoleMessage,
  createChainStartMessage,
  updateChainRoleContent,
} from "../chain-messages";
import type { ChainResult } from "@/lib/llm/chain-runner";

const t = ((key: string, options?: Record<string, unknown>) => {
  const labels: Record<string, string> = {
    "chat.workPanel.chainSteps.leader": "主对话",
    "chat.workPanel.chainSteps.architect": "架构师",
    "chat.workPanel.chainSteps.runner": "执行者",
  };
  if (labels[key]) return labels[key];
  if (key === "chat.orchestrator.chainStarted") return `开始执行：${options?.path}`;
  if (key === "chat.orchestrator.chainCompleted") return `已完成：${options?.path}`;
  if (key === "chat.orchestrator.chainStopped") return `接力已中止：${options?.role}`;
  return key;
}) as unknown as TFunction;

describe("chain message helpers", () => {
  it("builds localized chain path and receipt messages", () => {
    const path = buildChainPath({ chain: ["architect", "runner"], t });
    expect(path).toBe("主对话 → 架构师 → 执行者");

    expect(createChainStartMessage({ id: "start", createdAt: "now", total: 2, path, t })).toMatchObject({
      id: "start",
      kind: "receipt",
      content: "开始执行：主对话 → 架构师 → 执行者",
    });

    const completed: ChainResult = {
      stoppedAt: null,
      executedRoles: [{ role: "architect", content: "done" }],
      skippedRoles: [],
      roleHarness: {},
    };
    expect(createChainFinishMessage({ id: "done", createdAt: "now", result: completed, path, t }).content)
      .toBe("已完成：主对话 → 架构师 → 执行者");

    const stopped: ChainResult = { ...completed, stoppedAt: "runner" };
    expect(createChainFinishMessage({ id: "stop", createdAt: "now", result: stopped, path, t }).content)
      .toBe("接力已中止：runner");
  });

  it("updates role messages without baking labels into content", () => {
    const started = createChainRoleMessage({
      id: "role-1",
      createdAt: "now",
      role: "architect",
      index: 1,
      total: 2,
    });

    expect(started).toMatchObject({
      content: "",
      roleId: "architect",
      chainStep: { index: 1, total: 2 },
      chainDone: false,
    });

    const updated = updateChainRoleContent([started], "role-1", "第一段");
    expect(updated[0]?.content).toBe("第一段");

    const completed = completeChainRoleMessage({
      messages: updated,
      msgId: "role-1",
      content: "完整内容",
      index: 1,
      total: 2,
    });
    expect(completed[0]).toMatchObject({
      content: "完整内容",
      chainDone: true,
      chainStep: { index: 1, total: 2 },
    });
  });

  it("attaches harness warnings to matching role messages", () => {
    const messages = [
      createChainRoleMessage({ id: "a", createdAt: "now", role: "architect", index: 1, total: 1 }),
      { id: "plain", role: "assistant" as const, content: "普通消息" },
    ];
    const withWarnings = applyChainHarnessWarnings(messages, {
      architect: {
        unverifiedPaths: ["src/App.tsx"],
        pseudoToolNames: ["build"],
      },
    });

    expect(withWarnings[0]?.harness).toEqual({
      unverifiedPaths: ["src/App.tsx"],
      pseudoToolNames: ["build"],
      fabricatedUsageCount: null,
    });
    expect(withWarnings[1]).not.toHaveProperty("harness");
  });
});
