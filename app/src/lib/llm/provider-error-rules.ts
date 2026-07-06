// Provider 错误识别规则表（坑.md 1.2 修复）
//
// 解决：error-classifier.ts 原只用通用英文关键词兜底（"rate limit" / "quota exceeded" 等），
//       国产 provider（MiniMax/DeepSeek/GLM/Kimi）的中文错误体或非标准格式识别不到，
//       落到 unknown → shouldFallback=false → 触发不了回退链。
//
// 设计：
// 1. 每个 provider 一组"专属状态码 + 专属关键词"，覆盖该 provider 已知错误模式
// 2. classifyLlmError 在 statusCode 检查后、通用英文兜底前，调用本表匹配
// 3. 真实响应体格式靠 scripts/probe-rate-limit-errors.ts 探测后回填到本表
//    （人工维护的成本远低于 AI 瞎猜错误码）
// 4. 命中关键词时不区分大小写（provider 错误文案可能大小写不一致）
//
// 已知未实测：本表的中文关键词和自定义 code 是基于行业公开文档和经验值，
// 真实响应体格式需要跑 probe 脚本回填。**先按公开信息写，实际不准的部分等 probe 数据回来再调整**。

/** Provider 错误关键词模式集合 */
export interface ProviderErrorPatterns {
  /** 套餐/限流状态码（含 HTTP 标准 429 + provider 自定义 code） */
  rateLimitStatusCodes: number[];
  /** 鉴权失败状态码 */
  authStatusCodes: number[];
  /** 上下文超出状态码 */
  contextOverflowStatusCodes: number[];
  /** 模型不存在状态码 */
  modelNotFoundStatusCodes: number[];

  /** 套餐/限流关键词（中英双语，覆盖该 provider 已知错误文案） */
  rateLimitKeywords: string[];
  /** 鉴权失败关键词 */
  authKeywords: string[];
  /** 上下文超出关键词 */
  contextOverflowKeywords: string[];
  /** 模型不存在关键词 */
  modelNotFoundKeywords: string[];
}

/** 通用兜底规则（所有未在 PROVIDER_ERROR_PATTERNS 注册的 provider 走这套） */
export const DEFAULT_ERROR_PATTERNS: ProviderErrorPatterns = {
  rateLimitStatusCodes: [429, 529],
  authStatusCodes: [401, 403],
  contextOverflowStatusCodes: [413],
  modelNotFoundStatusCodes: [404],

  rateLimitKeywords: [
    "rate limit",
    "rate_limit",
    "quota exceeded",
    "quota_exceeded",
    "usage limit",
    "usage_limit",
    "too many requests",
    "rate-limit",
    "rate-limit-exceeded",
  ],
  authKeywords: [
    "unauthorized",
    "invalid api key",
    "invalid token",
    "authentication failed",
    "auth failed",
  ],
  contextOverflowKeywords: [
    "context length",
    "context window",
    "context_length",
    "context_window",
    "context size",
    "context_size",
    "too long",
    "reduce the length",
  ],
  modelNotFoundKeywords: [
    "model not found",
    "model_not_found",
    "invalid model",
    "unknown model",
    "model does not exist",
  ],
};

/**
 * 各 provider 专属规则。
 *
 * ⚠️ 以下中文关键词和自定义 code 基于公开文档/经验，**未实测**。
 * 真实响应体请用 scripts/probe-rate-limit-errors.ts 探测后回填。
 */
export const PROVIDER_ERROR_PATTERNS: Record<string, ProviderErrorPatterns> = {
  MiniMax: {
    // 2026-07-02 probe 实测：
    //   MiniMax 路径走 /chat/completions（OpenAI 协议风格），但错误体是 Anthropic 风格
    //   错 key → HTTP 401 + { type, error: { type: "authorized_error", message: "login fail: ... (1004)", http_code: "401" } }
    //   message 里括号包的自定义 code（1004=鉴权失败）作为 statusCode 识别
    rateLimitStatusCodes: [429, 529, 1305],
    authStatusCodes: [401, 403, 1004, 1005],
    contextOverflowStatusCodes: [413, 1003],
    modelNotFoundStatusCodes: [404, 1002],

    rateLimitKeywords: [
      "rate limit",
      "rate_limit",
      "quota exceeded",
      "quota_exceeded",
      "usage limit",
      "too many requests",
      "billing",
      "insufficient balance",
      // 中文
      "余额不足",
      "配额超限",
      "限流",
      "频率限制",
      "请求过快",
      "额度不足",
    ],
    authKeywords: [
      "unauthorized",
      "invalid api key",
      "invalid token",
      "authentication failed",
      "auth failed",
      // 2026-07-02 probe 实测：MiniMax 用 "login fail" + "authorized_error"
      "login fail",
      "authorized_error",
      "API secret key",
      // 中文
      "鉴权失败",
      "密钥无效",
      "认证失败",
      "未授权",
    ],
    contextOverflowKeywords: [
      "context length",
      "context window",
      "too long",
      "上下文过长",
      "超出上下文",
      "超出长度",
    ],
    modelNotFoundKeywords: ["model not found", "invalid model", "模型不存在", "模型无效"],
  },

  deepseek: {
    // 公开信息：deepseek 401=鉴权失败，429=限流，402=配额耗尽（按调用计费）
    // 2026-07-02 probe 实测：
    //   错 key → HTTP 401 + { error: { message: "Authentication Fails, Your api key: ****RONG is invalid", type: "authentication_error" } }
    //   模型不存在 → HTTP 400 + { error: { message: "The supported API model names are ..., but you passed ...", type: "invalid_request_error" } }
    //   错误格式跟 OpenAI 标准完全一样（{error: {message, type, code, param}}）
    rateLimitStatusCodes: [429, 402],
    authStatusCodes: [401, 403],
    // DeepSeek 实测：用 400 表示 model_not_found，不是 context_overflow
    // contextOverflowKeywords 让关键词匹配捕获 context overflow（实测没拿到真实数据）
    contextOverflowStatusCodes: [413],
    // 2026-07-02 代码审查发现：DeepSeek 确实用 400 表达 model_not_found，但 400 是通用
    // "bad request" 状态码，任何参数错误都会返回 400——如果把 400 直接放进
    // modelNotFoundStatusCodes，matchProviderByStatusCode 会纯按状态码匹配（不看消息内容），
    // 导致所有 400 类错误（哪怕跟模型无关）都被误判成 model_not_found 触发不必要的 fallback，
    // 掩盖真实问题。改成只靠 modelNotFoundKeywords 匹配消息内容（下面已经有
    // "model names are"/"but you passed"/"模型不存在" 等实测关键词，覆盖面足够）。
    modelNotFoundStatusCodes: [404],

    rateLimitKeywords: [
      "rate limit",
      "rate_limit",
      "quota exceeded",
      "insufficient balance",
      "余额不足",
      "配额超限",
      "额度不足",
    ],
    authKeywords: [
      "unauthorized",
      "invalid api key",
      "authentication failed",
      // 2026-07-02 probe 实测：DeepSeek 用 "Authentication Fails"（注意复数 + 大写 A）
      "Authentication Fails",
      "鉴权失败",
      "密钥无效",
    ],
    contextOverflowKeywords: [
      "context length",
      "context window",
      "too long",
      "上下文过长",
    ],
    // 2026-07-02 probe 实测：DeepSeek 用 "model names are" + "but you passed" 模式
    modelNotFoundKeywords: [
      "model not found",
      "invalid model",
      "model names are",
      "but you passed",
      "模型不存在",
    ],
  },

  glm: {
    // 2026-07-02 probe 实测 GLM 真实响应体（脚本：scripts/probe-rate-limit-errors.ts）：
    //   超大 prompt → HTTP 429 + body.code=1305 + "该模型当前访问量过大，请您稍后再试"
    //     （智谱对 context overflow 不抛 413，而是当 rate_limit 处理——友好行为，fallback 可救）
    //   模型不存在 → HTTP 400 + body.code=1211 + "模型不存在，请检查模型代码。"
    //     （智谱用 400 而不是 404）
    //   错 key → HTTP 200 + 正常回答（智谱对 key 后缀宽松；key 失效则返回 401 + "令牌已过期"）
    // 实测自定义 code：1305（限流）、1211（模型不存在）。原猜测的 1001/1002/1201/1202/1214 保留兼容。
    rateLimitStatusCodes: [429, 1305, 1214, 1215],
    authStatusCodes: [401, 403, 1001, 1002],
    // 智谱实测对超大 prompt 返回 429（rate_limit），不返回 413。
    // contextOverflowStatusCodes 保留为兼容性（万一未来智谱改回 413）：
    contextOverflowStatusCodes: [413, 1201],
    // 2026-07-02 代码审查发现：同 DeepSeek 的理由，400 太通用，不能纯按状态码判 model_not_found，
    // 改靠 modelNotFoundKeywords 匹配消息内容（"模型不存在"/"请检查模型代码" 已覆盖实测文案）。
    // 1211/1202 是智谱自定义 code（不是标准 HTTP 400 范围），可以安全按状态码匹配，保留。
    modelNotFoundStatusCodes: [404, 1211, 1202],

    rateLimitKeywords: [
      "rate limit",
      "quota exceeded",
      "too many requests",
      // 2026-07-02 probe 实测中文限流文案
      "访问量过大",
      "稍后再试",
      // 通用中文
      "余额不足",
      "配额超限",
      "限流",
      "频率限制",
    ],
    authKeywords: [
      "unauthorized",
      "invalid api key",
      "authentication failed",
      "鉴权失败",
      "密钥无效",
      "认证失败",
      // 2026-07-02 probe 实测 GLM 真实错误体（key 已过期场景）
      "令牌已过期",
      "验证不正确",
    ],
    contextOverflowKeywords: [
      "context length",
      "context window",
      "too long",
      "上下文过长",
      // 智谱实测不对超大 prompt 返回 413，但保留关键词以防万一
    ],
    modelNotFoundKeywords: [
      "model not found",
      "invalid model",
      // 2026-07-02 probe 实测
      "模型不存在",
      "请检查模型代码",
    ],
  },

  kimi: {
    // Moonshot Kimi：公开信息 401/403=鉴权，429=限流，413=上下文过长
    rateLimitStatusCodes: [429],
    authStatusCodes: [401, 403],
    contextOverflowStatusCodes: [413, 400],
    modelNotFoundStatusCodes: [404],

    rateLimitKeywords: [
      "rate limit",
      "rate_limit",
      "quota exceeded",
      "too many requests",
      "余额不足",
      "限流",
      "额度不足",
    ],
    authKeywords: [
      "unauthorized",
      "invalid api key",
      "authentication failed",
      "鉴权失败",
      "密钥无效",
    ],
    contextOverflowKeywords: ["context length", "context window", "too long", "上下文过长"],
    modelNotFoundKeywords: ["model not found", "invalid model", "模型不存在"],
  },
};

/**
 * 取出指定 provider 的错误规则。
 * - providerType 未传 / 未注册 → DEFAULT_ERROR_PATTERNS
 * - openai / openai-compatible → DEFAULT_ERROR_PATTERNS（这些 provider 走 OpenAI 协议标准错误体）
 */
export function getProviderPatterns(providerType: string | undefined): ProviderErrorPatterns {
  if (!providerType) return DEFAULT_ERROR_PATTERNS;
  const patterns = PROVIDER_ERROR_PATTERNS[providerType];
  if (patterns) return patterns;
  if (providerType.startsWith("openai")) return DEFAULT_ERROR_PATTERNS;
  return DEFAULT_ERROR_PATTERNS;
}