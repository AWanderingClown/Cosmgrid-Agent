import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import { messages as dbMessages, toolExecutions } from "@/lib/db";
import type { ChainCallbacks, ChainResult } from "@/lib/llm/chain-runner";
import type { RoleId } from "@/lib/llm/orchestrator";
import {
  applyChainHarnessWarnings,
  buildChainPath,
  completeChainRoleMessage,
  createChainFinishMessage,
  createChainRoleMessage,
  createChainStartMessage,
  updateChainRoleContent,
} from "./chain-messages";
import type { ChatMessage } from "./types";

interface ChainRunStateSetters {
  setChainExecutedRoles: (updater: RoleId[] | ((prev: RoleId[]) => RoleId[])) => void;
  setChainSkippedRoles: (updater: RoleId[] | ((prev: RoleId[]) => RoleId[])) => void;
  setChainAbortedRole: (role: RoleId | null) => void;
  setChainRunning: (running: boolean) => void;
}

export function startChainRun(setters: ChainRunStateSetters) {
  setters.setChainExecutedRoles([]);
  setters.setChainSkippedRoles([]);
  setters.setChainAbortedRole(null);
  setters.setChainRunning(true);
}

export function createChainRunCallbacks(args: {
  chain: RoleId[];
  conversationId: string;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setChainExecutedRoles: (updater: RoleId[] | ((prev: RoleId[]) => RoleId[])) => void;
  t: TFunction;
}): {
  callbacks: ChainCallbacks;
  chainPath: string;
  getCurrentMessageId: () => string | null;
} {
  const roleMsgIds: Partial<Record<RoleId, string>> = {};
  const roleMsgContents: Partial<Record<RoleId, string>> = {};
  const chainCurrentMessageIdRef: { current: string | null } = { current: null };
  const chainPath = buildChainPath({ chain: args.chain, t: args.t });

  return {
    chainPath,
    getCurrentMessageId: () => chainCurrentMessageIdRef.current,
    callbacks: {
      onChainStart: (total) => {
        const id = crypto.randomUUID();
        args.setMessages((prev) => [
          ...prev,
          createChainStartMessage({ id, createdAt: new Date().toISOString(), total, path: chainPath, t: args.t }),
        ]);
      },
      onRoleStart: (role, idx, total) => {
        const id = crypto.randomUUID();
        roleMsgIds[role] = id;
        chainCurrentMessageIdRef.current = id;
        roleMsgContents[role] = "";
        args.setMessages((prev) => [
          ...prev,
          createChainRoleMessage({ id, createdAt: new Date().toISOString(), role, index: idx + 1, total }),
        ]);
      },
      onRoleDelta: (role, delta) => {
        const msgId = roleMsgIds[role];
        if (!msgId) return;
        roleMsgContents[role] = (roleMsgContents[role] ?? "") + delta;
        args.setMessages((prev) => updateChainRoleContent(prev, msgId, roleMsgContents[role] ?? ""));
      },
      onRoleDone: (role, idx, total, content) => {
        const msgId = roleMsgIds[role];
        args.setChainExecutedRoles((prev) => (prev.includes(role) ? prev : [...prev, role]));
        void dbMessages.create({
          conversationId: args.conversationId,
          role: "assistant",
          content,
          actorRole: role,
          chainStepIndex: idx + 1,
          chainStepTotal: total,
          chainDone: true,
        }).catch(() => {});
        if (!msgId) return;
        args.setMessages((prev) => completeChainRoleMessage({
          messages: prev,
          msgId,
          content,
          index: idx + 1,
          total,
        }));
      },
      onUsage: (_usage, _model, _fr) => {
        // 链内 usage 由每跳 streamWithFallback 统一落库
      },
    },
  };
}

export async function finishChainRun(args: {
  result: ChainResult;
  chainPath: string;
  conversationId: string;
  applyToolExecutionRows: (rows: Awaited<ReturnType<typeof toolExecutions.listByConversation>>) => void;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setChainSkippedRoles: (updater: RoleId[] | ((prev: RoleId[]) => RoleId[])) => void;
  setChainAbortedRole: (role: RoleId | null) => void;
  t: TFunction;
}) {
  if (Object.keys(args.result.roleHarness).length > 0) {
    args.setMessages((prev) => applyChainHarnessWarnings(prev, args.result.roleHarness));
  }
  if (args.result.stoppedAt !== null) {
    args.setChainAbortedRole(args.result.stoppedAt);
  }
  const finishId = crypto.randomUUID();
  args.setMessages((prev) => [
    ...prev,
    createChainFinishMessage({
      id: finishId,
      createdAt: new Date().toISOString(),
      result: args.result,
      path: args.chainPath,
      t: args.t,
    }),
  ]);
  if (args.result.skippedRoles.length > 0) {
    args.setChainSkippedRoles(args.result.skippedRoles);
  }
  try {
    args.applyToolExecutionRows(await toolExecutions.listByConversation(args.conversationId));
  } catch {
    // 工件刷新失败不影响已完成的接力消息
  }
}
