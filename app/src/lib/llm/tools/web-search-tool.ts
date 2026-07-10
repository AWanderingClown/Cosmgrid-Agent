// web_search 工具（2026-07-05 新增）——补上 web_fetch 的另一半：不知道 URL 时怎么找。
//
// 后端选 Tavily：专为 LLM agent 设计的搜索 API，返回的 content 已经是摘要，不需要我们自己
// 再抓网页正文二次摘要。Key 走现有 keystore（跟模型 API Key 一样存系统凭据库），
// credentialId 固定为 TAVILY_SEARCH_CREDENTIAL_ID，供 SettingsPage 复用同一个 id 存取。

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./types";
import { getApiKey } from "@/lib/keystore";

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
  async execute(input): Promise<ToolResult> {
    const apiKey = await getApiKey(TAVILY_SEARCH_CREDENTIAL_ID);
    if (!apiKey) {
      return {
        status: "denied",
        output: "未配置搜索 API Key——请用户到设置页「网页搜索」填写 Tavily API Key 后再试。",
      };
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
        return { status: "error", output: `搜索请求失败：HTTP ${res.status}` };
      }
      const data = (await res.json()) as { results?: TavilyResult[] };
      const results = data.results ?? [];
      if (results.length === 0) {
        return { status: "success", output: `没有搜到关于「${input.query}」的相关结果。` };
      }
      const body = results
        .map((r, i) => `${i + 1}. ${r.title ?? "(无标题)"}\n   ${r.url ?? ""}\n   ${r.content ?? ""}`.trimEnd())
        .join("\n\n");
      return { status: "success", output: body };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        status: "error",
        output: aborted
          ? `搜索超时（>${SEARCH_TIMEOUT_MS / 1000}s）`
          : `搜索失败：${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
