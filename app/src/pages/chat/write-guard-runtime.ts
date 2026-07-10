import type { Dispatch, SetStateAction } from "react";
import { impliesWriteIntent } from "@/lib/llm/tool-permission-policy";
import type { TurnIntentDecision } from "@/lib/workflow/types";
import type { ChatMessage } from "@/pages/chat/types";

export type ChatPermissionMode = "read" | "confirm" | "auto";

export interface WriteGuardLabels {
  noWorkspace: string;
  readOnly: string;
  dynamicModelPool: string;
}

export interface ResolveWriteGuardRuntimeArgs {
  text: string;
  decision: TurnIntentDecision | null;
  workspacePath: string | null;
  permissionMode: ChatPermissionMode;
  conversationId: string | null;
  assistantId: string;
  promptedConversationIds: Set<string>;
  escalatePermission?: () => Promise<boolean>;
  labels: WriteGuardLabels;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
}

export interface ResolveWriteGuardRuntimeResult {
  effectivePermissionMode: ChatPermissionMode;
}

export async function resolveWriteGuardRuntime(
  args: ResolveWriteGuardRuntimeArgs,
): Promise<ResolveWriteGuardRuntimeResult> {
  let effectivePermissionMode = args.permissionMode;
  const decision = args.decision ?? {
    action: "answer_only",
    targetRunId: null,
    confidence: 1,
    reason: "write-guard-default",
    evidenceTurnIds: [],
  };

  const insertWriteGuardNotice = () => {
    const noticeMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: !args.workspacePath ? args.labels.noWorkspace : args.labels.readOnly,
      createdAt: new Date().toISOString(),
      modelLabel: args.labels.dynamicModelPool,
      kind: "system-notice",
    };
    args.setMessages((prev) => {
      const idx = prev.findIndex((message) => message.id === args.assistantId);
      if (idx === -1) return [...prev, noticeMsg];
      return [...prev.slice(0, idx), noticeMsg, ...prev.slice(idx)];
    });
  };

  if (
    !impliesWriteIntent({ text: args.text, decision }) ||
    (args.workspacePath && args.permissionMode !== "read")
  ) {
    return { effectivePermissionMode };
  }

  const alreadyPrompted = args.conversationId
    ? args.promptedConversationIds.has(args.conversationId)
    : true;
  if (
    args.workspacePath &&
    args.permissionMode === "read" &&
    args.escalatePermission &&
    !alreadyPrompted
  ) {
    if (args.conversationId) args.promptedConversationIds.add(args.conversationId);
    const escalated = await args.escalatePermission();
    if (escalated) {
      effectivePermissionMode = "confirm";
    } else {
      insertWriteGuardNotice();
    }
  } else {
    insertWriteGuardNotice();
  }

  return { effectivePermissionMode };
}
