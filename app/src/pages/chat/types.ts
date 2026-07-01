import type { Attachment } from "@/lib/llm/attachments";
import type { RoleId } from "@/lib/llm/orchestrator";

export interface HarnessWarning {
  unverifiedPaths: string[];
  pseudoToolNames: string[];
}

export interface ReceiptContent {
  summary: string;
  detail: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  modelLabel?: string;
  switched?: boolean;
  switchedTo?: string;
  usage?: { inputTokens: number; outputTokens: number };
  kind?: "chat" | "receipt" | "system-notice";
  receipt?: ReceiptContent;
  attachments?: Attachment[];
  harness?: HarnessWarning;
  roleId?: RoleId;
  chainStep?: { index: number; total: number };
  chainDone?: boolean;
}

export type PendingSend = { text: string; attachments?: Attachment[] };
