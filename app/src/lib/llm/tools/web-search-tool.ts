// web_search 工具（2026-07-05 新增）——补上 web_fetch 的另一半：不知道 URL 时怎么找。
//
// 后端选 Tavily：专为 LLM agent 设计的搜索 API，返回的 content 已经是摘要，不需要我们自己
// 再抓网页正文二次摘要。Key 走现有 keystore（跟模型 API Key 一样存系统凭据库），
// credentialId 固定为 TAVILY_SEARCH_CREDENTIAL_ID，供 SettingsPage 复用同一个 id 存取。
//
// Harness 阶段2（2026-07-11）：返回 ToolResultV2。
// - 未配置 API Key → errorResult{TOOL_DENIED, retryable=false}（等用户配 Key）
// - HTTP 5xx / 网络层错误 → errorResult{TOOL_NETWORK_ERROR, retryable=true}
// - HTTP 4xx → errorResult{TOOL_HTTP_ERROR, retryable=false}
// - 超时 → timeoutResult
// - 0 结果 → successResult + nextAction["broaden_query"]
// - 命中 → successResult + 多个 url artifact

import { z } from "zod";
import type { ToolDefinition } from "./types";
import { getApiKey } from "@/lib/keystore";
import {
  errorResult,
  successResult,
  timeoutResult,
  TOOL_DENIED,
  TOOL_HTTP_ERROR,
  TOOL_NETWORK_ERROR,
  type ToolResultV2,
} from "./result-contract";

/** SettingsPage 存 Tavily key 时用同一个 credentialId，走通用 keystore（不建独立的 provider 实体） */
export const TAVILY_SEARCH_CREDENTIAL_ID = "tavily-search";

const SEARCH_TIMEOUT_MS = 15000;
const MAX_RESULTS = 8;

const paramsSchema = z.object({
  query: z.string().describe("要搜索的查询词"),
});

type WebSearchParams = z.infer<typeof paramsSchema>;

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

export const webSearchTool: ToolDefinition<WebSearchParams> = {
  name: "web_search",
  description:
    "在公网搜索，返回相关网页的标题/摘要/链接列表。用于你不知道具体 URL、需要先找信息来源的场景；" +
    "如果已经有明确 URL 想看内容，直接用 web_fetch。需要用户在设置页配置搜索 API Key，没配置会拒绝。",
  parameters: paramsSchema,
  readOnly: true,
  security: { kind: "none" },
  async execute(input): Promise<ToolResultV2> {
    const apiKey = await getApiKey(TAVILY_SEARCH_CREDENTIAL_ID);
    if (!apiKey) {
      return errorResult({
        output: "未配置搜索 API Key——请用户到设置页「网页搜索」填写 Tavily API Key 后再试。",
        summary: "web_search 未配 Key",
        error: {
          code: TOOL_DENIED,
          rootCauseHint: "系统里没有 Tavily Search API Key",
          retryable: false,
          stopCondition: "必须等用户在设置页填写 Key 后再试——这一步绕不开",
        },
        nextActions: [
          {
            action: "ask_user_to_configure",
            reason: "需要用户到设置页填 Tavily Search API Key",
            safe: true,
          },
        ],
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, query: input.query, max_results: MAX_RESULTS }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const isRateLimit = res.status === 429;
        return errorResult({
          output: `搜索请求失败：HTTP ${res.status}`,
          summary: `web_search HTTP ${res.status}`,
          error: {
            code: TOOL_HTTP_ERROR,
            rootCauseHint: `Tavily Search 返回 HTTP ${res.status}`,
            retryable: isRateLimit || res.status >= 500,
            retryInstruction: isRateLimit
              ? "429 限流——退避 30 秒后重试"
              : res.status >= 500
                ? "服务端临时错误——可以重试一次"
                : `HTTP ${res.status}（如 401 可能是 Key 无效）——不要盲目重试`,
            stopCondition: isRateLimit || res.status >= 500
              ? undefined
              : "4xx 通常是 Key 问题，让用户检查配置",
          },
        });
      }
      const data = (await res.json()) as { results?: TavilyResult[] };
      const results = data.results ?? [];
      if (results.length === 0) {
        return successResult({
          output: `没有搜到关于「${input.query}」的相关结果。`,
          summary: `web_search 无结果 "${input.query}"`,
          nextActions: [
            {
              action: "broaden_query",
              reason: "query 太具体或拼写不对，试试放宽（去掉品牌名 / 加行业关键词）",
              safe: true,
            },
            {
              action: "switch_keyword",
              reason: "中文/英文换一下试试",
              safe: true,
            },
          ],
        });
      }
      const body = results
        .map((r, i) => `${i + 1}. ${r.title ?? "(无标题)"}\n   ${r.url ?? ""}\n   ${r.content ?? ""}`.trimEnd())
        .join("\n\n");
      return successResult({
        output: body,
        summary: `web_search "${input.query}" → ${results.length} 条`,
        artifacts: results
          .filter((r) => typeof r.url === "string")
          .map((r) => ({
            kind: "url" as const,
            uri: r.url!,
            label: r.title ?? "(无标题)",
          })),
        nextActions: [
          {
            action: "use_web_fetch_for_top",
            reason: "用 web_fetch 看最相关那条的完整内容",
            safe: true,
          },
        ],
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      if (aborted) {
        return timeoutResult({
          output: `搜索超时（>${SEARCH_TIMEOUT_MS / 1000}s）`,
          summary: `web_search 超时`,
        });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult({
        output: `搜索失败：${msg}`,
        summary: "web_search 网络层失败",
        error: {
          code: TOOL_NETWORK_ERROR,
          rootCauseHint: msg,
          retryable: true,
          retryInstruction: "网络层错误通常跟 DNS / 出口网络有关，可以稍后重试",
          stopCondition: "连续失败 2 次后停下，可能是用户网络问题",
        },
      });
    } finally {
      clearTimeout(timer);
    }
  },
};