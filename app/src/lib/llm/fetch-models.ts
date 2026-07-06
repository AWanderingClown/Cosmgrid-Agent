// 拉取某厂商账号下「真实可用」的模型列表——粘 API Key 后一键拉取，用户从真实列表勾选，
// 从根上杜绝手敲模型名填错（如 DeepSeek 填 "deepseek" 而非 "deepseek-chat"）。
//
// 各协议 /models 端点 + 鉴权方式不同（已 curl 核实路径存在）：
//   - openai / openai-compatible：GET {base}/models      头 Authorization: Bearer KEY   解析 data[].id
//   - anthropic：              GET {base}/v1/models   头 x-api-key + anthropic-version  解析 data[].id
//   - google：                 GET {base}/models?key=KEY                                解析 models[].name（剥 "models/" 前缀）
//   - claude-cli / codex-cli：  无 /models 端点 → unsupported

export interface FetchModelsResult {
  ok: boolean;
  models: string[];
  /** i18n key（在 addProvider.fetchModels.errors.* 下），ok=false 时有 */
  errorKey?: string;
  status?: number;
}

/** 明显不是对话模型的 id 关键词（embedding/语音/图像等），过滤掉减少噪音 */
const NON_CHAT_MARKERS = ["embed", "whisper", "tts", "dall-e", "dalle", "moderation", "rerank", "audio", "image", "vision-encoder"];

function isChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !NON_CHAT_MARKERS.some((m) => lower.includes(m));
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** 解析 OpenAI 风格 { data: [{id}] } */
function parseOpenAiList(json: unknown): string[] {
  const data = (json as { data?: Array<{ id?: unknown }> })?.data;
  if (!Array.isArray(data)) return [];
  return data.map((d) => d?.id).filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** 解析 Google { models: [{name: "models/xxx"}] } */
function parseGoogleList(json: unknown): string[] {
  const models = (json as { models?: Array<{ name?: unknown }> })?.models;
  if (!Array.isArray(models)) return [];
  return models
    .map((m) => (typeof m?.name === "string" ? m.name.replace(/^models\//, "") : null))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

function statusToErrorKey(status: number): string {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "notFound";
  return "unknown";
}

/**
 * 拉取模型列表。失败不抛错，返回 { ok:false, errorKey } 供 UI 友好提示。
 */
export async function fetchAvailableModels(params: {
  providerType: string;
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<FetchModelsResult> {
  const { providerType, apiKey } = params;
  const base = stripTrailingSlash(params.baseUrl);

  if (providerType === "claude-cli" || providerType === "codex-cli") {
    return { ok: false, models: [], errorKey: "unsupported" };
  }
  if (!base) return { ok: false, models: [], errorKey: "noBaseUrl" };
  if (!apiKey) return { ok: false, models: [], errorKey: "noKey" };

  let url: string;
  const headers: Record<string, string> = {};
  let parser: (json: unknown) => string[];

  if (providerType === "anthropic") {
    url = `${base}/v1/models`;
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    // Anthropic 默认拦截浏览器直连(WebView 也算)；带上这个头才放行，否则 CORS 失败
    headers["anthropic-dangerous-direct-browser-access"] = "true";
    parser = parseOpenAiList;
  } else if (providerType === "google") {
    url = `${base}/models?key=${encodeURIComponent(apiKey)}`;
    parser = parseGoogleList;
  } else {
    // openai / openai-compatible
    url = `${base}/models`;
    headers["Authorization"] = `Bearer ${apiKey}`;
    parser = parseOpenAiList;
  }

  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: params.signal ?? AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { ok: false, models: [], errorKey: statusToErrorKey(res.status), status: res.status };
    }
    const json: unknown = await res.json();
    const all = parser(json);
    const chat = all.filter(isChatModel);
    // 过滤后为空就退回全部（避免过滤过头把对话模型也滤掉，宁可多给）
    const models = chat.length > 0 ? chat : all;
    models.sort((a, b) => a.localeCompare(b));
    if (models.length === 0) return { ok: false, models: [], errorKey: "empty" };
    return { ok: true, models };
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    return { ok: false, models: [], errorKey: isAbort ? "timeout" : "network" };
  }
}
