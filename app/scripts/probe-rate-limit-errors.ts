// probe-rate-limit-errors.ts（1.2 真实验证入口 + 2026-07-02 多协议支持）
//
// 用途：探测各国产 / 主流 provider 的真实错误响应体（状态码 + body 结构 + 中文文案），
// 把结果贴给 AI，AI 据此更新 app/src/lib/llm/provider-error-rules.ts 规则表。
//
// ⚠️ 这个脚本只**读响应体**，不烧 token：故意触发 401/413/404 等"已确定会出错"的请求，
// 不需要先耗尽真配额。
//
// 用法：
//   PROBE_BASE_URL=https://open.bigmodel.cn/api/paas/v4 \
//   PROBE_API_KEY=your-key \
//   PROBE_MODEL_NAME=glm-4-flash \
//   PROBE_PROVIDER_TYPE=glm \
//   pnpm tsx scripts/probe-rate-limit-errors.ts
//
// 支持的 provider（自动选协议 + 路径 + 请求体格式）：
//   - glm / deepseek / kimi  → OpenAI 协议（POST /chat/completions）
//   - MiniMax          → MiniMax 兼容协议（POST /v1/text/chatcompletion_v2，含 system prompt）
//   - anthropic        → Anthropic 协议（POST /v1/messages，需 anthropic-version header）
//   - 其他             → 按 PROBE_PROTOCOL=openai|anthropic 手动指定
//
// 高级 override（脚本假设不对时）：
//   PROBE_PROTOCOL=openai|anthropic  强制协议
//   PROBE_CHAT_PATH=/custom/path      自定义路径

type Protocol = "openai" | "anthropic";

interface ProviderConfig {
  displayName: string;
  protocol: Protocol;
  chatPath: string;
  buildRequestBody: (model: string, userContent: string) => Record<string, unknown>;
  extraHeaders?: Record<string, string>;
}

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  glm: {
    displayName: "智谱 GLM",
    protocol: "openai",
    // ⚠️ 约定：base URL 必含 /v1 后缀（如 https://open.bigmodel.cn/api/paas/v4 末尾的 v4）
    //         chatPath 不重复 /v1 前缀（避免出现 /v1/v1 重复）
    chatPath: "/chat/completions",
    buildRequestBody: (model, content) => ({
      model,
      messages: [{ role: "user", content }],
    }),
  },
  deepseek: {
    displayName: "DeepSeek",
    protocol: "openai",
    chatPath: "/chat/completions",
    buildRequestBody: (model, content) => ({
      model,
      messages: [{ role: "user", content }],
    }),
  },
  kimi: {
    displayName: "Kimi（月之暗面）",
    protocol: "openai",
    chatPath: "/chat/completions",
    buildRequestBody: (model, content) => ({
      model,
      messages: [{ role: "user", content }],
    }),
  },
  MiniMax: {
    displayName: "MiniMax",
    protocol: "openai",
    // 2026-07-02 probe 实测：MiniMax 实际走 OpenAI 路径 /chat/completions（不是 Anthropic 风格的 /text/chatcompletion_v2）
    // 但错误格式是 Anthropic 风格（{type, error: {type, message, http_code}, request_id}）
    chatPath: "/chat/completions",
    buildRequestBody: (model, content) => ({
      model,
      messages: [{ role: "user", content }],
    }),
  },
  anthropic: {
    displayName: "Anthropic Claude",
    protocol: "anthropic",
    chatPath: "/messages",
    buildRequestBody: (model, content) => ({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: content.slice(0, 1000) }],
    }),
    extraHeaders: {
      "anthropic-version": "2023-06-01",
    },
  },
};

const BASE_URL = process.env.PROBE_BASE_URL;
const API_KEY = process.env.PROBE_API_KEY;
const MODEL_NAME = process.env.PROBE_MODEL_NAME ?? "test-model";
const PROVIDER_TYPE = process.env.PROBE_PROVIDER_TYPE ?? "unknown";
const PROTOCOL_OVERRIDE = process.env.PROBE_PROTOCOL as Protocol | undefined;
const CHAT_PATH_OVERRIDE = process.env.PROBE_CHAT_PATH;

if (!BASE_URL || !API_KEY) {
  console.error("❌ 缺少必要环境变量：");
  console.error("   PROBE_BASE_URL    e.g. https://open.bigmodel.cn/api/paas/v4");
  console.error("   PROBE_API_KEY     你的 key");
  console.error("   PROBE_MODEL_NAME  e.g. glm-4-flash");
  console.error("   PROBE_PROVIDER_TYPE  glm / deepseek / kimi / MiniMax / anthropic");
  console.error("");
  console.error("可选 override（脚本假设不对时）：");
  console.error("   PROBE_PROTOCOL=openai|anthropic   强制协议");
  console.error("   PROBE_CHAT_PATH=/custom/path       自定义路径");
  console.error("");
  console.error("示例：");
  console.error("   PROBE_BASE_URL=https://open.bigmodel.cn/api/paas/v4 \\");
  console.error("   PROBE_API_KEY=xxx \\");
  console.error("   PROBE_MODEL_NAME=glm-4-flash \\");
  console.error("   PROBE_PROVIDER_TYPE=glm \\");
  console.error("   pnpm tsx scripts/probe-rate-limit-errors.ts");
  console.error("");
  console.error("已知 provider 路径（base URL 必含 /v1 后缀）：");
  for (const [k, v] of Object.entries(PROVIDER_CONFIGS)) {
    console.error(`   ${k.padEnd(10)} → ${v.protocol.padEnd(8)} ${v.chatPath}`);
  }
  console.error("");
  console.error("⚠️ base URL 示例（必须含 /v1 后缀）：");
  console.error("   glm        → https://open.bigmodel.cn/api/paas/v4");
  console.error("   deepseek   → https://api.deepseek.com/v1");
  console.error("   kimi       → https://api.moonshot.cn/v1");
  console.error("   MiniMax    → https://api.minimaxi.com/v1");
  console.error("   anthropic  → https://api.anthropic.com/v1");
  console.error("");
  console.error("⚠️ export 时不要在行尾加 # 注释（bash 会报 'export: not valid in this context'）");
  console.error("   错误示例：export X=1 # 注释");
  console.error("   正确：   export X=1    # 想加注释另起一行");
  process.exit(1);
}

const config = PROVIDER_CONFIGS[PROVIDER_TYPE] ?? null;

interface ProbeResult {
  scenario: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  parsedBody: unknown;
}

async function probe(
  scenario: string,
  url: string,
  init: RequestInit,
): Promise<ProbeResult> {
  console.log(`\n--- ${scenario} ---`);
  console.log(`URL: ${url}`);
  console.log(`Method: ${init.method ?? "GET"}`);
  try {
    const res = await fetch(url, init);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const body = await res.text();
    let parsedBody: unknown = body;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      // not JSON, keep as string
    }
    const result: ProbeResult = {
      scenario,
      status: res.status,
      statusText: res.statusText,
      headers,
      body,
      parsedBody,
    };
    console.log(`Status: ${res.status} ${res.statusText}`);
    console.log(`Headers:`);
    for (const [k, v] of Object.entries(headers)) {
      console.log(`  ${k}: ${v}`);
    }
    console.log(`Body:`);
    console.log(JSON.stringify(parsedBody, null, 2));
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`❌ Fetch failed: ${msg}`);
    return {
      scenario,
      status: 0,
      statusText: "FETCH_FAILED",
      headers: {},
      body: msg,
      parsedBody: msg,
    };
  }
}

async function main() {
  // 决定协议 + 路径
  const protocol: Protocol = PROTOCOL_OVERRIDE ?? config?.protocol ?? "openai";
  const chatPath = CHAT_PATH_OVERRIDE ?? config?.chatPath ?? "/chat/completions";
  const buildBody =
    config?.buildRequestBody ??
    ((model: string, content: string) =>
      protocol === "anthropic"
        ? { model, max_tokens: 1024, messages: [{ role: "user", content }] }
        : { model, messages: [{ role: "user", content }] });
  const extraHeaders = config?.extraHeaders ?? {};

  const displayName = config?.displayName ?? PROVIDER_TYPE;
  console.log("🔍 探测 provider 真实错误响应体");
  console.log(`Provider Type: ${PROVIDER_TYPE} (${displayName})`);
  console.log(`Protocol: ${protocol}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Chat Path: ${chatPath}`);
  console.log(`Model: ${MODEL_NAME}`);

  const url = `${BASE_URL.replace(/\/$/, "")}${chatPath}`;

  const results: ProbeResult[] = [];

  // 场景 1：故意用错误 key 触发 401
  const wrongKey = API_KEY + "_WRONG";
  const authHeader =
    protocol === "anthropic"
      ? `Bearer ${wrongKey}` // MiniMax 也是 Bearer
      : `Bearer ${wrongKey}`;
  results.push(
    await probe("scenario-1-wrong-api-key (expect 401)", url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
        ...extraHeaders,
      },
      body: JSON.stringify(buildBody(MODEL_NAME, "hi")),
    }),
  );

  // 场景 2：发送超大 prompt 触发 413
  // 注意：有些 provider 会返回 429 限流而不是 413 context overflow（GLM 实测就是这样）
  const hugePrompt = "请详细回答这个问题 ".repeat(100_000);
  results.push(
    await probe(
      "scenario-2-huge-prompt (expect 413 or 429)",
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          ...extraHeaders,
        },
        body: JSON.stringify(buildBody(MODEL_NAME, hugePrompt)),
      },
    ),
  );

  // 场景 3：用不存在的模型触发 404 / 400
  // 注意：有些 provider 模型不存在返 400 而不是 404（GLM 实测就是这样）
  results.push(
    await probe(
      "scenario-3-nonexistent-model (expect 404 or 400)",
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          ...extraHeaders,
        },
        body: JSON.stringify(
          buildBody(
            "this-model-definitely-does-not-exist-12345",
            "hi",
          ),
        ),
      },
    ),
  );

  console.log("\n\n========== 总结 ==========");
  for (const r of results) {
    console.log(`${r.scenario}: status=${r.status}, bodyLength=${r.body.length}`);
  }
  console.log("\n复制上面的 body 输出贴给 AI，AI 据此更新 provider-error-rules.ts 规则表。");
  console.log("重点关注：");
  console.log("  - body 的 JSON 结构（error.code / error.message / error.type 等字段名）");
  console.log("  - body 的中文/英文文案（用来更新关键词表）");
  console.log("  - 自定义状态码字段（如果有，作为 rateLimitStatusCodes 等）");
}

void main();