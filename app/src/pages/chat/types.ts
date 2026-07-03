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

/** SmartRouter 在 handleSmartPick 里写、handleSend 读的路由决策镜像（避免 stale closure）。
 *  原本 useModelSelection 和 useChatStream 各重复定义一次——统一放 types.ts。 */
export interface PendingRoutingDecision {
  prompt: string;
  baselineModelId: string;
  baselineModelName: string;
  baselineProviderType?: string | null;
  actualModelId: string;
}
