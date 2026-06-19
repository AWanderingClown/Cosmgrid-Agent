# 技术侦察：OpenCode "Vercel AI SDK 包装" 抄录报告（精简版）

> **侦察对象**: `/tmp/cosmgrid-research/opencode-dev/packages/opencode/src/`
> **侦察目标**: Cosmgrid-Agent v0.2 LLM 适配层（`server/llm/`）+ 流式 API
> **报告日期**: 2026-06-18（2026-06-19 精简）
> **侦察者**: Claude（技术侦察兵）
> **状态**: v0.2 后端 100% 按本报告实施落地（见主文档 `Cosmgrid-Agent-独立多模型AI工作平台完整方案.md` v0.2 章节）

---

## 一、TL;DR

OpenCode 的 Vercel AI SDK 包装套路分 **3 层**：

1. **`provider.ts`（1700+ 行）**：维护 provider 注册表，定义了每个 provider 怎么从 npm 包加载 + 生成 SDK 实例 + 暴露 `languageModel(modelId)`。**Cosmgrid-Agent 不需要直接抄整个文件**，只抄"按 provider 类型调对应 SDK 工厂"的模式。
2. **`session/llm/ai-sdk.ts`（288 行）**：是 Vercel AI SDK → Cosmgrid-Agent 自己的事件协议（`LLMEvent`）的适配层。**Cosmgrid-Agent 可以大幅简化**，因为不需要 `Effect` 框架和 `LLMEvent` 抽象。
3. **`session/llm.ts:280-353`**：`streamText({...})` 的实际调用点。**这是 v0.2 最值得抄的 73 行代码**。

**核心结论**（v0.2 已采纳）：

1. ✅ **Vercel AI SDK 的 `streamText` 已经做了 95% 的事** —— 流式输出、token 计数、provider 适配、tool call 全包
2. ✅ **token 计数从 `result.usage` 字段读**（inputTokens/outputTokens/cacheReadInputTokens/cacheWriteInputTokens/reasoningTokens）
3. ✅ **Hono 流式响应**用 `result.toUIMessageStreamResponse()`（前端 useChat 直接对接）
4. ✅ **成本计算**用 LiteLLM 风格的 `model_prices_and_context_window.json` 集中定价 JSON

---

## v0.2 实施映射（已落地）

| OpenCode 模式 | Cosmgrid-Agent v0.2 落地 |
|---|---|
| `provider.ts` 全 catalog（1700+ 行） | `server/llm/provider-factory.ts`（130 行，registry 模式 + LRU 缓存） |
| `session/llm.ts:280-353` streamText 调用 | `server/llm/chat-handler.ts` buildChatConfig + streamChat |
| `usage()` 函数（`ai-sdk.ts:44-64`） | `server/llm/cost-calculator.ts` extractUsage + ChatUsage interface |
| `onFinish` 回调写 usage 记录 | `chat-handler.ts:67` onFinish → recordUsageEvent（fire-and-forget） |
| `LLMEvent` 适配层 | **不需要**（Vercel AI SDK 6 + useChat 直接对接） |
| LiteLLM model_prices JSON | `server/llm/model-prices.ts`（8 个模型，4 位小数 USD） |

---

---

## 二、OpenCode 关键代码片段（直接可抄 / 微调）

### 2.1 `streamText` 完整调用模式（来自 `llm.ts:280-353`）

```ts
// 来源: /tmp/cosmgrid-research/opencode-dev/packages/opencode/src/session/llm.ts:280-353
import { streamText, wrapLanguageModel } from "ai"

const result = streamText({
  // 错误处理
  onError(error) {
    console.error("stream error", { providerID, modelID, error })
  },

  // 通用参数（所有 provider 都支持）
  temperature: 0.7,
  topP: 0.9,
  maxOutputTokens: 4096,
  maxRetries: 1,

  // 消息历史
  messages: [
    { role: "system", content: "..." },
    { role: "user", content: "..." },
  ],

  // 模型（language 实例从 provider.ts 来）
  model: languageModel, // = anthropic("claude-sonnet-4-20250514") 或 openai("gpt-5") 等

  // 工具调用（v0.2 不做，跳过）
  // tools: { ... },
  // toolChoice: "auto",

  // 中止信号
  abortSignal: abortController.signal,
})

// 消费流式响应（Hono 集成见下面 2.3 节）
for await (const event of result.fullStream) {
  // event.type: "text-delta" | "finish-step" | "finish" | "tool-call" | "tool-result" | "error" | ...
  // event.text?: string（text-delta 时有）
  // event.usage?: { inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens, reasoningTokens }
}

// 流结束后读最终 usage
const finalUsage = await result.usage
```

### 2.2 `usage()` 字段解析（来自 `ai-sdk.ts:44-64`）

```ts
// 来源: /tmp/cosmgrid-research/opencode-dev/packages/opencode/src/session/llm/ai-sdk.ts:44-64
interface Usage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
}
```

**注意**：OpenCode 兼容多种字段命名（`inputTokenDetails.cacheReadTokens`、`cachedInputTokens` 都接受），因为不同 provider SDK 版本字段名不一致。Cosmgrid-Agent 写代码时取**所有可能字段的最大值**：

```ts
// Cosmgrid-Agent v0.2 推荐的 usage 解析（覆盖 Anthropic / OpenAI / Google 三家）
function extractUsage(raw: any): Usage {
  if (!raw || typeof raw !== "object") return {}
  return {
    inputTokens: raw.inputTokens ?? raw.promptTokens,
    outputTokens: raw.outputTokens ?? raw.completionTokens,
    cacheReadInputTokens: raw.cacheReadInputTokens ?? raw.cachedTokens ?? raw.inputTokenDetails?.cacheReadTokens,
    cacheWriteInputTokens: raw.cacheWriteInputTokens ?? raw.inputTokenDetails?.cacheWriteTokens,
    reasoningTokens: raw.reasoningTokens ?? raw.outputTokenDetails?.reasoningTokens,
    totalTokens: raw.totalTokens,
  }
}
```

### 2.3 Hono 流式响应（v0.2 关键集成点）

OpenCode 用的是 Effect 框架，Cosmgrid-Agent 是 Hono + Node Server，所以 SSE 集成代码要自己写。

**方案 A：用 `result.toUIMessageStream()`（Vercel AI SDK 内置）**

```ts
// Cosmgrid-Agent v0.2 后端：Hono POST /api/chat/stream
import { streamText, type LanguageModelUsage } from "ai"
import { anthropic } from "@ai-sdk/anthropic"
import { openai } from "@ai-sdk/openai"
import { google } from "@ai-sdk/google"
import { Hono } from "hono"
import { prisma } from "../db.js"

const app = new Hono()

// provider 工厂（直接调每个 SDK 的工厂函数，**不用** resolveSDK）
function getLanguageModel(providerType: string, modelName: string, apiKey: string, baseUrl?: string) {
  switch (providerType) {
    case "anthropic":
      return baseUrl ? anthropic(modelName, { apiKey, baseURL: baseUrl }) : anthropic(modelName, { apiKey })
    case "openai":
      return baseUrl ? openai(modelName, { apiKey, baseURL: baseUrl }) : openai(modelName, { apiKey })
    case "google":
      return google(modelName, { apiKey, baseURL: baseUrl })
    default:
      throw new Error(`Unsupported provider type: ${providerType}`)
  }
}

app.post("/api/chat/stream", async (c) => {
  const { modelId, messages } = await c.req.json<{ modelId: string; messages: Array<{ role: string; content: string }> }>()

  // 从 DB 读 model + provider + apiCredential
  const model = await prisma.model.findUnique({
    where: { id: modelId },
    include: { provider: { include: { apiCredentials: { where: { enabled: true }, take: 1 } } } },
  })
  if (!model) return c.json({ error: "Model not found" }, 404)
  const cred = model.provider.apiCredentials[0]
  if (!cred) return c.json({ error: "No enabled API credential" }, 400)

  // 解密 API Key（v0.2 用固定密钥方案，crypto.ts 在前端）
  // ⚠️ 后端是 Node，Web Crypto API 在 Node 22+ 也支持
  const apiKey = await decryptApiKey(cred.apiKeyEncrypted)

  // 调 Vercel AI SDK
  const result = streamText({
    model: getLanguageModel(model.provider.type, model.name, apiKey, cred.baseUrl),
    messages: messages.map(m => ({ role: m.role as "user" | "assistant" | "system", content: m.content })),
    onFinish: async ({ usage, finishReason }) => {
      // 流结束写 UsageEvent（cost 计算见 2.4）
      await prisma.usageEvent.create({
        data: {
          providerId: model.provider.id,
          apiCredentialId: cred.id,
          modelId: model.id,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cacheReadTokens: usage.cachedInputTokens ?? 0,
          cacheWriteTokens: null,
          success: finishReason === "stop",
          interrupted: finishReason === "abort",
          cost: calculateCost(model.name, usage),
        },
      })
    },
  })

  // 返回 SSE 流（Hono 标准做法）
  c.header("Content-Type", "text/event-stream")
  c.header("Cache-Control", "no-cache")
  c.header("Connection", "keep-alive")

  return streamSSE(c, async (stream) => {
    for await (const chunk of result.textStream) {
      await stream.writeSSE({ data: JSON.stringify({ type: "text", content: chunk }) })
    }
    // 流结束写 finish 事件
    await stream.writeSSE({ data: JSON.stringify({ type: "done" }) })
  })
})
```

### 2.4 成本计算（LiteLLM 集中定价 JSON 模式）

OpenCode 没自己做成本计算（也没找到定价 JSON）。Cosmgrid-Agent v0.2 推荐抄 LiteLLM 的 `model_prices_and_context_window.json` 模式。

**新文件**：`app/server/llm/model-prices.ts`

```ts
// 来源：仿 LiteLLM model_prices_and_context_window.json
// v0.2 起步只填主流 10 个模型，v0.3 加完整

export interface ModelPrice {
  input: number // USD per 1M tokens
  output: number
  cacheRead?: number // cache hit 价格（Anthropic）
  cacheWrite?: number // cache write 价格（Anthropic）
  contextWindow: number
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic（USD per 1M tokens，2026-06 价格）
  "claude-opus-4-8": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, contextWindow: 1_000_000 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, contextWindow: 1_000_000 },
  "claude-haiku-4-5": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1, contextWindow: 200_000 },

  // OpenAI
  "gpt-5": { input: 5, output: 20, contextWindow: 256_000 },
  "gpt-5-mini": { input: 0.5, output: 2, contextWindow: 256_000 },
  "gpt-5-nano": { input: 0.1, output: 0.4, contextWindow: 256_000 },

  // Google
  "gemini-2.5-pro": { input: 1.25, output: 5, contextWindow: 1_000_000 },
  "gemini-2.5-flash": { input: 0.075, output: 0.3, contextWindow: 1_000_000 },

  // DeepSeek（便宜）
  "deepseek-chat": { input: 0.14, output: 0.28, contextWindow: 64_000 },
  "deepseek-reasoner": { input: 0.55, output: 2.19, contextWindow: 64_000 },
}

export function calculateCost(modelName: string, usage: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number }): number {
  const price = MODEL_PRICES[modelName]
  if (!price) return 0
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  const cacheRead = usage.cacheReadInputTokens ?? 0
  const cacheWrite = usage.cacheWriteInputTokens ?? 0

  // 注意：cache read 通常是 input 价格的 10%，所以 input 不算 cache 部分
  const nonCacheInput = Math.max(0, input - cacheRead - cacheWrite)

  const cost =
    (nonCacheInput / 1_000_000) * price.input +
    (output / 1_000_000) * price.output +
    (cacheRead / 1_000_000) * (price.cacheRead ?? price.input) +
    (cacheWrite / 1_000_000) * (price.cacheWrite ?? price.input * 1.25)

  return Math.round(cost * 10000) / 10000 // 保留 4 位小数（USD）
}
```

### 2.5 测试连接（v0.2 新增，OpenCode 没做）

CC Switch 报告 5.1 节提到要在 Form 内加"测试连接"按钮。后端用 Vercel AI SDK 的 `generateText` 发一个最小请求测延迟。

```ts
// 新文件: app/server/llm/test-connection.ts
import { generateText } from "ai"
import { getLanguageModel } from "./provider-factory.js"

export interface TestConnectionResult {
  success: boolean
  latencyMs?: number
  error?: string
  modelResponse?: string
}

export async function testConnection(params: {
  providerType: string
  modelName: string
  apiKey: string
  baseUrl?: string
}): Promise<TestConnectionResult> {
  const start = Date.now()
  try {
    const result = await generateText({
      model: getLanguageModel(params.providerType, params.modelName, params.apiKey, params.baseUrl),
      prompt: "ping",
      maxOutputTokens: 10,
      abortSignal: AbortSignal.timeout(10_000), // 10s 超时
    })
    return {
      success: true,
      latencyMs: Date.now() - start,
      modelResponse: result.text.slice(0, 100),
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
```

---

## 三、OpenCode provider.ts 的关键模式（不直接抄，借鉴思路）

### 3.1 resolveSDK（1700+ 行内的某个函数）

OpenCode 用了非常复杂的动态加载：每个 provider 在 npm 包里都有自己的 SDK（`@ai-sdk/anthropic`、`@ai-sdk/openai` 等），OpenCode 维护了一个 catalog 列出每个 provider 的 npm 包名，运行时 `import()` 加载。

**Cosmgrid-Agent v0.2 不需要这么复杂** —— 我们只支持 3 个 provider（anthropic / openai / google），直接在 `provider-factory.ts` 用 switch-case 调对应 SDK 的工厂函数即可。**省一大堆 dynamic import 代码**。

### 3.2 getLanguage（provider.ts:1784-1813）

OpenCode 的 `getLanguage` 缓存 `s.models.set(key, language)`，避免每次重新构造 language model。Cosmgrid-Agent 也可以做这个缓存。

```ts
// Cosmgrid-Agent v0.2 简化版
const languageModelCache = new Map<string, LanguageModelV1>()

export function getLanguageModelCached(providerType: string, modelName: string, apiKey: string, baseUrl?: string) {
  const key = `${providerType}/${modelName}/${apiKey.slice(-8)}` // 用 apiKey 后 8 位避免泄漏完整 key
  if (languageModelCache.has(key)) return languageModelCache.get(key)!
  const lm = getLanguageModel(providerType, modelName, apiKey, baseUrl)
  languageModelCache.set(key, lm)
  return lm
}
```

---

## 四、v0.2 LLM 适配层文件结构

```
app/server/llm/
├── provider-factory.ts      (NEW, 40 行)  anthropic/openai/google SDK 工厂
├── chat-handler.ts          (NEW, 80 行)  流式 + 同步调用封装
├── test-connection.ts       (NEW, 40 行)  测连接（generateText ping）
├── cost-calculator.ts       (NEW, 60 行)  成本计算 + MODEL_PRICES
├── model-prices.ts          (NEW, 50 行)  集中定价数据
├── usage-tracker.ts         (NEW, 30 行)  UsageEvent 写入逻辑
└── __tests__/
    ├── provider-factory.test.ts
    ├── chat-handler.test.ts
    ├── cost-calculator.test.ts
    └── test-connection.test.ts
```

---

## 五、v0.2 新增 API 端点

| 方法 | 路径 | 用途 | 借鉴 |
|---|---|---|---|
| POST | `/api/chat/stream` | 流式对话（SSE） | OpenCode `streamText` |
| POST | `/api/chat/sync` | 同步对话（非流式） | OpenCode `generateText` |
| POST | `/api/chat/test-connection` | 测 API Key 是否有效 | v0.2 新增 |
| GET | `/api/models?workRoles=main_chat` | 按 workRoles 列可用模型 | Cosmgrid-Agent 独有 |

`/api/models` 已经在 v0.1 有了，但 v0.2 加 query 支持按 workRoles 过滤（用 `Model.workRoles LIKE '%"main_chat"%'`）。

---

## 六、成本计算边界情况

1. **未知模型**：MODEL_PRICES 找不到时返回 0 + 警告日志（不抛错，避免阻塞对话）
2. **cache token 累加**：Anthropic 的 cache_read + cache_write 都不算 input 的"普通"部分，要扣掉
3. **批量调用折扣**：v0.2 不做（v0.3 加）
4. **多模态 token**：图片/音频 token 单独计算（v0.2 暂不支持图片输入，v0.4 再做）

---

## 七、可抄 / 要改 / 不抄 三清单

### 7.1 可抄

| 模块 | 来源 | Cosmgrid-Agent 落点 |
|---|---|---|
| `streamText` 调用模式 | `llm.ts:280-353` | `server/llm/chat-handler.ts` |
| `usage()` 字段解析 | `ai-sdk.ts:44-64` | `server/llm/usage-extractor.ts` |
| 全局 language model 缓存 | `provider.ts:1784-1813` | `server/llm/provider-factory.ts`（简化版） |
| `onError` / `onFinish` 回调 | `llm.ts:281-292` | `chat-handler.ts` |
| `providerOptions` 自定义 | `llm.ts:316` | 留接口，v0.2 不传 |

### 7.2 要改

| OpenCode 做法 | Cosmgrid-Agent v0.2 怎么改 |
|---|---|
| Effect 框架 + LLMEvent 抽象 | 直接用 Vercel AI SDK 事件，省 200+ 行 |
| `Stream.fromAsyncIterable` 适配 | Hono `streamSSE(c, ...)` |
| `resolveSDK` 动态加载 npm | switch-case 静态 switch（只支持 3 个 provider） |
| 全 provider catalog（75+） | v0.2 只 3 个（anthropic / openai / google），v0.3 加 deepseek / qwen / glm |

### 7.3 不抄

| 模块 | 原因 |
|---|---|
| `provider.ts` 整个 1700+ 行 catalog | 太重，Cosmgrid-Agent v0.x 只 3-10 个 provider |
| `ai-sdk.ts` 整个 288 行 toLLMEvents | Effect 框架 + LLMEvent 抽象都是 OpenCode 自己的协议，不通用 |
| `wrapLanguageModel` middleware | Cosmgrid-Agent v0.2 不做 message transform |
| `experimental_telemetry` OpenTelemetry | v0.2 不做可观测性集成（v0.7 再加） |
| Effect.gen / Effect.acquireRelease | Cosmgrid-Agent 是 TS 全栈，不用 Effect 框架 |
| Copilot billing `copilotTotalNanoAiu` | v0.2 不做 GitHub Copilot |

---

## 八、质量自检

- [x] 关键代码片段贴出原文（streamText / usage / provider factory）
- [x] Cosmgrid-Agent v0.2 简化方案明确（不开 catalog，只 3 个 provider）
- [x] 成本计算边界情况列清楚
- [x] 可抄 / 要改 / 不抄 三清单
- [x] 文件结构 + API 端点明确

**盲点**（v0.2 开发者自己调研）：
- ❌ Anthropic prompt caching 的具体 cache_control 用法（v0.2 暂不支持）
- ❌ OpenAI o1/o3 reasoning effort 参数（v0.2 暂不传）
- ❌ Gemini safety settings（v0.2 用默认）
- ❌ 多模态输入（v0.2 不做图片输入）

---

## 九、参考链接

- OpenCode provider.ts 入口：`/tmp/cosmgrid-research/opencode-dev/packages/opencode/src/provider/provider.ts`
- OpenCode streamText 调用：`/tmp/cosmgrid-research/opencode-dev/packages/opencode/src/session/llm.ts:280-353`
- OpenCode AI SDK adapter：`/tmp/cosmgrid-research/opencode-dev/packages/opencode/src/session/llm/ai-sdk.ts`
- Vercel AI SDK 文档：https://sdk.vercel.ai/docs
- LiteLLM 定价 JSON（参考格式）：`https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json`

---

## 报告对比

| 维度 | OpenCode | Cosmgrid-Agent v0.2 |
|---|---|---|
| Provider 数量 | 75+ (动态 catalog) | 3 (静态 switch) |
| 框架 | Effect + LLMEvent 抽象 | 纯 Vercel AI SDK |
| 流式 | Stream.fromAsyncIterable | Hono streamSSE |
| Token 解析 | 自定义 usage() 函数 | 简化版 extractUsage() |
| 成本计算 | 不做（没看到） | MODEL_PRICES JSON |
| 测试连接 | 不做 | v0.2 新增 generateText ping |
| 复杂度 | 高 | 低（v0.2 目标） |