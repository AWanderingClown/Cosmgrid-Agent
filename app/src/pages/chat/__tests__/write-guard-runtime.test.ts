import { describe, expect, it, vi } from "vitest";
import type { TurnIntentDecision } from "@/lib/workflow/types";
import { resolveWriteGuardRuntime } from "@/pages/chat/write-guard-runtime";
import type { ChatMessage } from "@/pages/chat/types";

const writeDecision: TurnIntentDecision = {
  action: "answer_only",
  targetRunId: null,
  confidence: 1,
  reason: "test",
  evidenceTurnIds: [],
  patch: { executionMode: "execute_directly" },
};

describe("resolveWriteGuardRuntime", () => {
  it("普通聊天不改权限，也不插提示", async () => {
    const setMessages = vi.fn();

    const result = await resolveWriteGuardRuntime({
      text: "解释一下这个概念",
      decision: null,
      workspacePath: "/tmp/project",
      permissionMode: "read",
      conversationId: "conv-1",
      assistantId: "assistant-1",
      promptedConversationIds: new Set(),
      escalatePermission: vi.fn(),
      labels: labels(),
      setMessages,
    });

    expect(result.effectivePermissionMode).toBe("read");
    expect(setMessages).not.toHaveBeenCalled();
  });

  it("有写意图但没有工作区时只插提示，不弹权限升级", async () => {
    const setMessages = vi.fn();
    const escalatePermission = vi.fn();

    const result = await resolveWriteGuardRuntime({
      text: "帮我写入文件",
      decision: writeDecision,
      workspacePath: null,
      permissionMode: "read",
      conversationId: "conv-1",
      assistantId: "assistant-1",
      promptedConversationIds: new Set(),
      escalatePermission,
      labels: labels(),
      setMessages,
    });

    expect(result.effectivePermissionMode).toBe("read");
    expect(escalatePermission).not.toHaveBeenCalled();
    const update = setMessages.mock.calls[0]?.[0] as (messages: ChatMessage[]) => ChatMessage[];
    expect(update([{ id: "assistant-1", role: "assistant", content: "" }])).toMatchObject([
      { content: "no workspace", kind: "system-notice" },
      { id: "assistant-1" },
    ]);
  });

  it("只读工作区首次写入会弹权限升级，同意后切到确认模式", async () => {
    const prompted = new Set<string>();
    const setMessages = vi.fn();

    const result = await resolveWriteGuardRuntime({
      text: "保存到文件",
      decision: writeDecision,
      workspacePath: "/tmp/project",
      permissionMode: "read",
      conversationId: "conv-1",
      assistantId: "assistant-1",
      promptedConversationIds: prompted,
      escalatePermission: vi.fn(async () => true),
      labels: labels(),
      setMessages,
    });

    expect(result.effectivePermissionMode).toBe("confirm");
    expect(prompted.has("conv-1")).toBe(true);
    expect(setMessages).not.toHaveBeenCalled();
  });

  it("用户拒绝权限升级时插入只读提示", async () => {
    const setMessages = vi.fn();

    const result = await resolveWriteGuardRuntime({
      text: "保存到文件",
      decision: writeDecision,
      workspacePath: "/tmp/project",
      permissionMode: "read",
      conversationId: "conv-1",
      assistantId: "assistant-1",
      promptedConversationIds: new Set(),
      escalatePermission: vi.fn(async () => false),
      labels: labels(),
      setMessages,
    });

    expect(result.effectivePermissionMode).toBe("read");
    const update = setMessages.mock.calls[0]?.[0] as (messages: ChatMessage[]) => ChatMessage[];
    expect(update([{ id: "assistant-1", role: "assistant", content: "" }])[0]).toMatchObject({
      content: "read only",
      kind: "system-notice",
    });
  });
});

function labels() {
  return {
    noWorkspace: "no workspace",
    readOnly: "read only",
    dynamicModelPool: "dynamic",
  };
}
