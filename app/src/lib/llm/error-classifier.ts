// LLM 错误分类 + 清洗
// 解决两个关键安全问题：
// 1. 用户截图报错时会泄漏 API Key 前缀（如 "sk-ant-api03-xxx"）
// 2. 原始错误信息对小白用户不友好（"TypeError: fetch failed at..."）
//
// 设计原则：
// 1. sanitizeError 永远剥掉 API Key 模式（防御性）
// 2. classifyLlmError 把错误分桶（401/403/429/超时/网络/未知）
// 3. 返回结构化结果 {httpStatus, userMessage, technicalMessage}，让路由层决策怎么响应

/**
 * LLM 错误分类
 */
export type LlmErrorCategory =
  | "auth_invalid" // 401 - API Key 无效 / 过期
  | "auth_forbidden" // 403 - 权限不足
  | "rate_limit" // 429 - 套餐耗尽
  | "timeout" // 请求超时
  | "network" // 网络故障
  | "context_overflow" // 上下文超出窗口
  | "model_not_found" // 404 - 模型下线
  | "server_error" // 5xx - provider 服务故障
  | "unknown"; // 其他

/**
 * 分类后的错误（结构化）
 */
export interface ClassifiedLlmError {
  category: LlmErrorCategory;
  /** 推荐 HTTP 状态码（给前端用） */
  httpStatus: number;
  /** 给用户看的中文友好文案 */
  userMessage: string;
  /** 给开发者/日志的技术详情（已脱敏） */
  technicalMessage: string;
  /**
   * 是否推荐回退到 fallback 模型
   * - true: 401/403/404/429/超时/网络/5xx → 切
   * - false: context_overflow（换模型也救不了）/ unknown（保守，可能是 bug）
   * chat-fallback 消费这个字段决定要不要切
   */
  shouldFallback: boolean;
}

/**
 * 已知 API Key 模式（用于从错误信息里剥离）
 * 覆盖：OpenAI / Anthropic / Google / DeepSeek / GLM
 */
const API_KEY_PATTERNS = [
  /sk-ant-(?:api03-)?[A-Za-z0-9_\-]+/g, // Anthropic
  /sk-proj-[A-Za-z0-9_\-]+/g, // OpenAI project
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI legacy
  /AIza[A-Za-z0-9_\-]+/g, // Google
  /gsk_[A-Za-z0-9_\-]+/g, // Grok
];

/** 统一的脱敏占位符（不暴露"被脱敏了"的事实，避免反向探测） */
const REDACTED = "[REDACTED]";

/**
 * 从任意错误信息里剥离 API Key 前缀（防御性）
 * @param raw - 原始错误信息
 * @returns 脱敏后的字符串
 */
export function sanitizeError(raw: unknown): string {
  if (raw == null) return "";
  let text = String(raw);
  for (const pattern of API_KEY_PATTERNS) {
    text = text.replace(pattern, REDACTED);
  }
  return text;
}

/**
 * 提取 HTTP 状态码（从 Vercel AI SDK / fetch 错误对象）
 * Vercel AI SDK 把 statusCode 放在 error.statusCode 或 error.response.status
 */
function extractStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as Record<string, unknown>;
  if (typeof e.statusCode === "number") return e.statusCode;
  if (typeof e.status === "number") return e.status;
  if (typeof e.code === "number") return e.code;
  // AI_APICallError 通常有 status
  if (typeof e.response === "object" && e.response !== null) {
    const response = e.response as Record<string, unknown>;
    if (typeof response.status === "number") return response.status;
  }
  return undefined;
}

/**
 * 提取错误消息文本
 */
function extractMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
  }
  return String(error);
}

/**
 * 把 LLM 错误分桶成结构化结果
 * @param error - 原始错误（可能是 Vercel AI SDK 的 AIError / fetch 错误 / 任意 Error）
 * @param t - (可选) i18next t 函数，传了之后 userMessage 会用 t() 翻译
 * @returns 分类结果 + 友好文案
 */
export function classifyLlmError(
  error: unknown,
  t?: (k: string) => string,
): ClassifiedLlmError {
  const rawMessage = extractMessage(error);
  const statusCode = extractStatusCode(error);
  const sanitized = sanitizeError(rawMessage);
  // 没传 t 时用中文（向后兼容）；传了 t 时用 t() 翻译，缺失 fallback 到 key
  const msg = (zh: string, key: string) => (t ? (t(key) || zh) : zh);

  if (/401|invalid authentication credentials|failed to authenticate|authentication_failed/i.test(rawMessage)) {
    return {
      category: "auth_invalid",
      httpStatus: 401,
      userMessage: msg("登录凭据无效或已过期，请重新登录对应 CLI / API 账号", "errorClassifier.auth_invalid"),
      technicalMessage: sanitized,
      shouldFallback: false,
    };
  }

  // 按 HTTP 状态码优先分类
  if (statusCode === 401) {
    return {
      category: "auth_invalid",
      httpStatus: 401,
      userMessage: msg("API Key 无效或已过期，请在 API 接入页检查", "errorClassifier.auth_invalid"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }
  if (statusCode === 403) {
    return {
      category: "auth_forbidden",
      httpStatus: 403,
      userMessage: msg("API Key 权限不足，请检查账户是否欠费或套餐限制", "errorClassifier.auth_forbidden"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }
  if (statusCode === 404) {
    return {
      category: "model_not_found",
      httpStatus: 404,
      userMessage: msg("模型不存在或已下线，请检查模型名称", "errorClassifier.model_not_found"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }
  if (statusCode === 413 || statusCode === 429) {
    // 413 = payload too large（上下文超出）
    if (statusCode === 413 || /context.{0,20}(length|window|size)/i.test(rawMessage)) {
      return {
        category: "context_overflow",
        httpStatus: 413,
        userMessage: msg("对话内容超出模型上下文窗口，请新建对话或缩短历史", "errorClassifier.context_overflow"),
        technicalMessage: sanitized,
        shouldFallback: false, // 换模型也救不了
      };
    }
    return {
      category: "rate_limit",
      httpStatus: 429,
      userMessage: msg("套餐额度已耗尽或被限流，请稍后重试或检查套餐状态", "errorClassifier.rate_limit"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return {
      category: "server_error",
      httpStatus: statusCode,
      userMessage: msg("AI 服务暂时不可用，请稍后重试", "errorClassifier.server_error"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }

  // 没状态码时按错误文本分类
  const lower = rawMessage.toLowerCase();
  if (
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("quota exceeded") ||
    lower.includes("usage limit") ||
    lower.includes("too many requests")
  ) {
    return {
      category: "rate_limit",
      httpStatus: 429,
      userMessage: msg("套餐额度已耗尽或被限流，请稍后重试或检查套餐状态", "errorClassifier.rate_limit"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }
  if (
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("invalid token") ||
    lower.includes("authentication failed") ||
    lower.includes("auth failed")
  ) {
    return {
      category: "auth_invalid",
      httpStatus: 401,
      userMessage: msg("API Key 无效或已过期，请在 API 接入页检查", "errorClassifier.auth_invalid"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }
  if (
    lower.includes("cli exited with code") ||
    lower.includes("process exited with code") ||
    lower.includes("child process exited") ||
    lower.includes("subprocess exited")
  ) {
    return {
      category: "server_error",
      httpStatus: 502,
      userMessage: msg("AI 执行进程异常退出，正在尝试自动恢复", "errorClassifier.server_error"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }
  if (lower.includes("timeout") || lower.includes("aborted") || lower.includes("timed out")) {
    return {
      category: "timeout",
      httpStatus: 504,
      userMessage: msg("请求超时，请检查网络或稍后重试", "errorClassifier.timeout"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed") ||
    lower.includes("network")
  ) {
    return {
      category: "network",
      httpStatus: 502,
      userMessage: msg("网络连接失败，请检查网络或 Base URL 配置", "errorClassifier.network"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }

  return {
    category: "unknown",
    httpStatus: 500,
    userMessage: msg("对话失败，请稍后重试", "errorClassifier.unknown"),
    technicalMessage: sanitized,
    shouldFallback: false, // 保守：unknown 多半是 bug，不浪费 fallback 配额
  };
}

/**
 * 公共 type guard：检查 unknown error 是否是 classifyLlmError 包装的结构化错误
 * 给路由层 catch 后转 HTTP response 用
 */
export function asClassifiedError(error: unknown): ClassifiedLlmError | null {
  if (
    error &&
    typeof error === "object" &&
    "category" in error &&
    "httpStatus" in error &&
    "userMessage" in error &&
    "shouldFallback" in error
  ) {
    return error as ClassifiedLlmError;
  }
  return null;
}
