import type { Attachment } from "@/lib/llm/attachments";
import type { RoleId } from "@/lib/llm/orchestrator";
import type { SwitchReason } from "@/lib/llm/chat-fallback";

export interface HarnessWarning {
  unverifiedPaths: string[];
  unverifiedUrls?: string[];
  unverifiedCommands?: string[];
  pseudoToolNames: string[];
  fabricatedUsageCount?: number | null;
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
  /** 真实切换原因（错误分类/冷却中/异常恢复）；工作面板据此显示具体原因，不能瞎猜成"限额" */
  switchReason?: SwitchReason;
  usage?: { inputTokens: number; outputTokens: number };
  kind?: "chat" | "receipt" | "system-notice";
  receipt?: ReceiptContent;
  attachments?: Attachment[];
  harness?: HarnessWarning;
  roleId?: RoleId;
  chainStep?: { index: number; total: number };
  chainDone?: boolean;
  /** 本轮真实工具调用次数；undefined = 未记录，不能据此判断 */
  toolCallCount?: number | null;
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
