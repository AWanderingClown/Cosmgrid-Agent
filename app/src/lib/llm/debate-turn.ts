import type { TFunction } from "i18next";
import type { CredentialListItem, ModelListItem } from "@/lib/api";
import { runDynamicDebate, type DebateResult, type DebateRoleConfig } from "./debate-engine";
import { archiveDynamicDebateResult } from "./debate-persistence";
import { buildDebateParticipants } from "./debate-participants";
import { buildDebateTopic, formatDebateResultMessage } from "./debate-result";
import { realRunRole } from "./debate-runner";

interface DebateMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  kind?: string;
}

interface ExecuteDebateTurnOptions {
  primaryModel: ModelListItem;
  availableModels: ModelListItem[];
  credentials: CredentialListItem[];
  workspacePath: string | null;
  messages: DebateMessage[];
  userMessage: DebateMessage;
  projectId: string | null;
  getApiKey: (credentialId: string) => Promise<string | null>;
  signal: AbortSignal;
  t: TFunction;
  onParticipants?: (participants: DebateRoleConfig[]) => void;
}

export interface ExecutedDebateTurn {
  participants: DebateRoleConfig[];
  result: DebateResult;
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export async function executeDebateTurn(
  options: ExecuteDebateTurnOptions,
): Promise<ExecutedDebateTurn> {
  const participants = await buildDebateParticipants({
    primaryModel: options.primaryModel,
    availableModels: options.availableModels,
    credentials: options.credentials,
    effectiveWorkspace: options.workspacePath,
    getApiKey: options.getApiKey,
    maxParticipants: 4,
  });
  if (participants.length === 0) {
    throw new Error(options.t("chat.debate.noParticipants"));
  }
  options.onParticipants?.(participants);

  const topic = buildDebateTopic({
    messages: options.messages,
    userMessage: options.userMessage,
  });
  const result = await runDynamicDebate(
    {
      topic,
      participants,
      maxParticipants: 4,
      maxIterations: 2,
      signal: options.signal,
    },
    realRunRole,
  );
  const modelNameFor = (modelId: string) => {
    const model = options.availableModels.find((candidate) => candidate.id === modelId);
    return model?.displayName || model?.name || modelId;
  };
  const formatted = formatDebateResultMessage({
    result,
    participantCount: participants.length,
    modelNameFor,
    t: options.t,
  });

  await archiveDynamicDebateResult({
    projectId: options.projectId,
    result,
  });

  return {
    participants,
    result,
    content: formatted.content,
    usage: formatted.usage,
  };
}
