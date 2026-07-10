// chat-fallback 相关的最小共享契约：
// - 纯数据类型，不带行为
// - invocation-audit / chat-fallback-types / chat-fallback-attempt 都会用到
// - 单独拆出来，避免 "types ↔ audit" 互相引用形成循环依赖

/** 一个可调用的模型端点：模型 + 凭证 + baseUrl */
export interface ModelEndpoint {
  /** DB 里 Model 表的 id（用于 cooldown 跟踪 + UsageEvent 关联） */
  modelId: string;
  /** 给 LLM 用的模型名（如 "claude-opus-4-8"） */
  modelName: string;
  /** "anthropic" / "openai" / "google" / "openai-compatible" */
  providerType: string;
  apiKey: string;
  baseUrl?: string;
  /** CLI provider 的工作目录：绑定工作文件夹时传入，避免 CLI 读到应用开发目录 */
  workingDirectory?: string | null;
  /** 给 UI 显示的标签（如 "Opus 4.8"），仅做展示 */
  displayLabel?: string;
  /** 对应 ApiCredential 的 id（用于 recordUsageEvent 落库关联） */
  apiCredentialId: string;
  /** 对应 Provider 的 id（用于 recordUsageEvent 落库关联） */
  providerId: string;
}

/** 单次模型调用的 usage 统一形状。 */
export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  /** 本轮真实工具调用次数（来自 stepToolCalls.length）。 */
  toolCallCount: number;
}
