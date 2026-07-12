// web_fetch 工具（2026-07-05 新增，同日两次修复：改走后端发请求 + 加真实渲染兜底）。
//
// 只读工具：不改本地任何文件。最初走的是 webview 里的 JS `fetch()`，但那是浏览器上下文，
// 会被 CORS 挡——目标网站没有回 `Access-Control-Allow-Origin`（绝大多数普通网站都没有，
// 它们只预期被浏览器直接打开），浏览器引擎就不让 JS 拿到响应内容，不管背后是哪个模型在
// 调用工具都一样抓不到（实测 okx.ai 就是这样：curl 直接 200 拿到完整内容，webview fetch
// 却一直失败）。
//
// 现在分两档，一档不行自动试下一档，不把"抓不到"这个中间过程丢给模型/用户：
// - Tier 1 `fetch_url_backend`：在 Rust 后端直接发 HTTP 请求，不是浏览器，没有 CORS 这个
//   限制，天然绕开。覆盖绝大多数网站（含普通 SSR/静态站）。
// - Tier 3 `fetch_url_rendered`：Tier 1 拿到的内容"看起来不完整"时兜底——真开一个隐藏的
//   浏览器窗口把网址加载一遍，等页面自己的 JS 跑完再读正文。用于"内容要等 JS 渲染完才出现"
//   的单页应用、或者故意只放行真浏览器的反爬网站。见 src-tauri/src/lib.rs 里的详细注释。
//
// SSRF 防护（闸门，见 assertSafeUrl，Rust 侧 assert_safe_url 是同一套逻辑的第二道保险）：
// 只挡"URL 里字面写死的"内网/危险地址——10.x/172.16-31.x/192.168.x/127.x/169.254.x
// （含云 metadata 169.254.169.254）/localhost。
// 已知局限：无法防御 DNS rebinding（一个公网域名解析到内网 IP）——跟 command-safety.ts
// 的黑名单式拦截同一个安全姿态：挡常见/明显的攻击面，不是密不透风的沙箱。
//
// Harness 阶段2（2026-07-11）：返回 ToolResultV2。
// - SSRF 命中 → errorResult{TOOL_INVALID_URL, retryable=false}（不可绕开，必须换 URL）
// - HTTP 4xx（401/403/404）→ errorResult{TOOL_HTTP_ERROR, retryable=false}
// - HTTP 5xx / 网络层失败 → errorResult{TOOL_NETWORK_ERROR, retryable=true}
// - 超时 → timeoutResult
// - HTTP 2xx/3xx → successResult + url artifact

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { ToolDefinition } from "./types";
import {
  errorResult,
  successResult,
  timeoutResult,
  TOOL_HTTP_ERROR,
  TOOL_INVALID_URL,
  TOOL_NETWORK_ERROR,
  type ToolResultV2,
} from "./result-contract";

const FETCH_OUTPUT_LIMIT = 8000;

const paramsSchema = z.object({
  url: z.string().describe("要抓取的网页 URL（必须是 http/https）"),
});

type WebFetchParams = z.infer<typeof paramsSchema>;

// 阶段 3 R7：黑名单常量已搬到 lib/security-invariants/ssrf-hosts.ts（PRIVATE hostnames 段）。
// IPv4 段判断保留在此（数值范围不能塞 SET，得用算法）。
import { isPrivateHost } from "@/lib/security-invariants/ssrf-hosts";

/** IPv4 字面量是否落在内网/回环/链路本地/云 metadata 网段 */
function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 回环
  if (a === 169 && b === 254) return true; // 169.254.0.0/16（含云 metadata 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

/** 校验 URL 是否允许抓取；不允许时返回拒绝原因 */
export function assertSafeUrl(rawUrl: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "URL 格式不合法" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `不支持的协议：${parsed.protocol}` };
  }
  const host = parsed.hostname.toLowerCase();
  if (isPrivateHost(host)) {
    return { ok: false, reason: "拒绝访问本机/内网地址" };
  }
  if (isPrivateIPv4(host)) {
    return { ok: false, reason: "拒绝访问内网/链路本地 IP 段" };
  }
  return { ok: true };
}

/** 极简 HTML → 纯文本：去 script/style，去标签，解常见实体，压缩空白 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/(p|div|br|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface BackendFetchResult {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
}

/** 常见反爬"挑战页"的文案特征——命中就说明 Tier 1 拿到的只是个空壳，得靠 Tier 3 真渲染 */
const BOT_CHALLENGE_MARKERS = [
  /enable javascript/i,
  /please turn on javascript/i,
  /just a moment/i,
  /checking your browser/i,
  /cf-browser-verification/i,
  /attention required/i,
];

const MIN_PLAUSIBLE_BODY_LENGTH = 200;

/** Tier 1 拿到的内容是不是"看起来不完整"——不完整才需要退到 Tier 3 真开浏览器渲染 */
function looksIncomplete(status: number, plainText: string): boolean {
  if (status < 200 || status >= 400) return true;
  const trimmed = plainText.trim();
  if (trimmed.length < MIN_PLAUSIBLE_BODY_LENGTH) return true;
  return BOT_CHALLENGE_MARKERS.some((re) => re.test(trimmed));
}

/**
 * 把 tier1/tier3 拿到的内容映射成 ToolResultV2。
 *  - 2xx/3xx → success
 *  - 401/403/404/410 → error{TOOL_HTTP_ERROR, retryable=false}（客户端错误，重试无意义）
 *  - 429/5xx → error{TOOL_HTTP_ERROR, retryable=true}（服务端临时错误，可以退避后重试）
 *  - body 为空但 status 200 → success 但 nextAction 提示"换源"
 */
function formatOutput(
  finalUrl: string,
  status: number,
  plainText: string,
): ToolResultV2 {
  const clipped = plainText.length > FETCH_OUTPUT_LIMIT ? plainText.slice(0, FETCH_OUTPUT_LIMIT) + "\n…(截断)" : plainText;
  const ok = status >= 200 && status < 400;
  const artifacts = [{ kind: "url" as const, uri: finalUrl, label: `HTTP ${status}` }];

  if (ok) {
    const empty = clipped.trim().length === 0;
    if (empty) {
      // status 200 但 body 是空 / 只有反爬挑战页：作为 warning，让模型换源
      return errorResult({
        output: `${finalUrl}（HTTP ${status}）\n(返回内容为空或被反爬页面占据)`,
        summary: `web_fetch ${finalUrl} 空响应`,
        artifacts,
        error: {
          code: TOOL_NETWORK_ERROR,
          rootCauseHint: "HTTP 200 但 body 是空 / 反爬挑战页（CDN 把 LLM 流量识别为机器人）",
          retryable: false,
          stopCondition: "这种网站通常 LLM 抓不到，不要重试；换 web_search 找替代来源",
        },
        nextActions: [
          { action: "switch_to_web_search", reason: "改用 web_search 找这个内容的其他来源", safe: true },
          { action: "ask_user_for_alternative_url", reason: "让用户给一个更友好的镜像 / 备用 URL", safe: true },
        ],
      });
    }
    return successResult({
      output: `${finalUrl}（HTTP ${status}）\n${clipped}`,
      summary: `web_fetch ${finalUrl} → ${clipped.length}B`,
      artifacts,
    });
  }

  // 4xx/5xx
  const isClientError = status >= 400 && status < 500;
  const isRateLimit = status === 429;
  return errorResult({
    output: `${finalUrl}（HTTP ${status}）\n${clipped}`,
    summary: `web_fetch ${finalUrl} → HTTP ${status}`,
    artifacts,
    error: {
      code: TOOL_HTTP_ERROR,
      rootCauseHint: `HTTP ${status}`,
      retryable: isRateLimit || status >= 500, // 5xx + 429 可重试；其他 4xx 不可
      retryInstruction: isRateLimit
        ? "429 限流——退避 30 秒后重试"
        : status >= 500
          ? "服务端临时错误——可以重试一次"
          : `HTTP ${status} 是客户端错误——不要重试，换 URL 或换源`,
      stopCondition: isClientError && !isRateLimit
        ? "4xx 错误重试无意义，停下换源（404/403 通常说明 URL 失效或没权限）"
        : undefined,
    },
  });
}

export const webFetchTool: ToolDefinition<WebFetchParams> = {
  name: "web_fetch",
  description: "抓取一个公网 URL 的内容并转成纯文本返回（只支持 http/https，拒绝内网/本机地址）。用于查资料、看文档、验证链接内容。",
  parameters: paramsSchema,
  readOnly: true,
  // L6 安全网收拢（2026-07-09）核实：command-safety.ts 只被 bash-tool.ts 真正调用，
  // web_fetch 的校验对象是 URL（SSRF 内网地址拦截）不是 shell 命令，跟 command-safety
  // 不是同一道安全网，不适合套 "command" kind，assertSafeUrl 继续留在工具内部自己调用。
  security: { kind: "none" },
  async execute(input): Promise<ToolResultV2> {
    const safety = assertSafeUrl(input.url);
    if (!safety.ok) {
      return errorResult({
        output: `已拦截：${safety.reason}`,
        summary: `web_fetch URL 拦截`,
        error: {
          code: TOOL_INVALID_URL,
          rootCauseHint: safety.reason,
          retryable: false,
          stopCondition: "SSRF 防护不允许该 URL（内网/私有地址）——必须换 URL，不能绕开",
        },
      });
    }

    let tier1PlainText = "";
    let tier1Result: BackendFetchResult | null = null;
    try {
      tier1Result = await invoke<BackendFetchResult>("fetch_url_backend", { url: input.url });
      tier1PlainText = tier1Result.contentType.includes("html") ? htmlToText(tier1Result.body) : tier1Result.body;
      if (!looksIncomplete(tier1Result.status, tier1PlainText)) {
        return formatOutput(tier1Result.finalUrl, tier1Result.status, tier1PlainText);
      }
    } catch {
      // Tier 1 直接失败，继续尝试 Tier 3 兜底
    }

    try {
      const rendered = await invoke<BackendFetchResult>("fetch_url_rendered", { url: input.url });
      return formatOutput(rendered.finalUrl, rendered.status, rendered.body);
    } catch (err) {
      // 两档都失败：Tier 1 如果好歹拿到了点内容，宁可把它给出去也不要空手而归
      if (tier1Result && tier1PlainText.trim().length > 0) {
        return formatOutput(tier1Result.finalUrl, tier1Result.status, tier1PlainText);
      }
      const msg = err instanceof Error ? err.message : String(err);
      const aborted = /abort/i.test(msg);
      if (aborted) {
        return timeoutResult({
          output: `请求超时：${msg}`,
          summary: `web_fetch 超时`,
        });
      }
      return errorResult({
        output: `请求失败（直接请求和真实渲染两种方式都试过了）：${msg}`,
        summary: `web_fetch 两档都失败`,
        error: {
          code: TOOL_NETWORK_ERROR,
          rootCauseHint: msg,
          retryable: true,
          retryInstruction: "网络层失败通常跟 DNS / 路由 / 目标站点不可达有关，可以隔一会儿再试一次",
          stopCondition: "连续失败 2 次后切到 web_search 找替代来源",
        },
      });
    }
  },
};