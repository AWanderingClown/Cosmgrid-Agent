import type { TFunction } from "i18next";
import type { ChainResult } from "@/lib/llm/chain-runner";
import type { RoleId } from "@/lib/llm/orchestrator";
import type { ChatMessage } from "./types";

export function buildChainPath(args: {
  chain: RoleId[];
  t: TFunction;
}): string {
  const chainStepLabel = (role: RoleId) => args.t(`chat.workPanel.chainSteps.${role}`);
  return [args.t("chat.workPanel.chainSteps.leader"), ...args.chain.map(chainStepLabel)].join(" → ");
}

export function createChainStartMessage(args: {
  id: string;
  createdAt: string;
  total: number;
  path: string;
  t: TFunction;
}): ChatMessage {
  return {
    id: args.id,
    role: "assistant",
    createdAt: args.createdAt,
    content: args.t("chat.orchestrator.chainStarted", { total: args.total, path: args.path }),
    kind: "receipt",
  };
}

export function createChainRoleMessage(args: {
  id: string;
  createdAt: string;
  role: RoleId;
  index: number;
  total: number;
}): ChatMessage {
  return {
    id: args.id,
    role: "assistant",
    createdAt: args.createdAt,
    content: "",
    roleId: args.role,
    chainStep: { index: args.index, total: args.total },
    chainDone: false,
  };
}

export function updateChainRoleContent(messages: ChatMessage[], msgId: string, content: string): ChatMessage[] {
  return messages.map((m) => (m.id === msgId ? { ...m, content } : m));
}

export function completeChainRoleMessage(args: {
  messages: ChatMessage[];
  msgId: string;
  content: string;
  index: number;
  total: number;
}): ChatMessage[] {
  return args.messages.map((m) =>
    m.id === args.msgId
      ? { ...m, content: args.content, chainDone: true, chainStep: { index: args.index, total: args.total } }
      : m,
  );
}

export function applyChainHarnessWarnings(
  messages: ChatMessage[],
  roleHarness: ChainResult["roleHarness"],
): ChatMessage[] {
  return messages.map((m) => {
    if (!m.roleId) return m;
    const warning = roleHarness[m.roleId];
    return warning
      ? {
          ...m,
          harness: {
            unverifiedPaths: warning.unverifiedPaths,
            pseudoToolNames: warning.pseudoToolNames,
            fabricatedUsageCount: warning.fabricatedUsageCount ?? null,
          },
        }
      : m;
  });
}

export function createChainFinishMessage(args: {
  id: string;
  createdAt: string;
  result: ChainResult;
  path: string;
  t: TFunction;
}): ChatMessage {
  return {
    id: args.id,
    role: "assistant",
    createdAt: args.createdAt,
    content: args.result.stoppedAt !== null
      ? args.t("chat.orchestrator.chainStopped", { role: args.result.stoppedAt })
      : args.t("chat.orchestrator.chainCompleted", {
          count: args.result.executedRoles.length,
          path: args.path,
        }),
    kind: "receipt",
  };
}
