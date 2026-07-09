import type { Attachment } from "@/lib/llm/attachments";
import type { RoleId } from "@/lib/llm/orchestrator";
import type { SwitchReason } from "@/lib/llm/chat-fallback";
import type { LlmInvocationAuditEvent } from "@/lib/llm/invocation-audit";
import type { FabricationSuspicion } from "@/lib/llm/harness/fabrication-constants";

export interface HarnessWarning {
  unverifiedPaths: string[];
  unverifiedUrls?: string[];
  unverifiedCommands?: string[];
  pseudoToolNames: string[];
  fabricatedUsageCount?: number | null;
  /**
   * 语义裁判（fabrication-judge）命中——本轮回答里的具体执行结果无法被工具证据对账。
   * UI 据此显示「未经核实的推测」之类的提示；纯前端展示，不影响重试链路（重试由
   * useChatStream 的 stream-retry 闭环处理，verdict 上的 fabricationSuspected 字段）。
   * 类型与后端 HarnessVerdict.fabricationSuspected 共用 FabricationSuspicion，避免两处定义漂移。
   */
  fabricationSuspected?: FabricationSuspicion | null;
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
  llmInvocations?: LlmInvocationAuditEvent[];
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
