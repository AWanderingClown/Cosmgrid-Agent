// web_fetch 工具（2026-07-05 新增）——补上工具层唯一缺失的联网能力。
//
// 只读工具：不改本地任何文件，走浏览器原生 fetch（Tauri CSP 为 null，webview 本身就能跨域请求，
// 跟 LLM API 调用走的是同一条路，不需要额外的 http 插件）。
//
// SSRF 防护（闸门，见 assertSafeUrl）：只挡"URL 里字面写死的"内网/危险地址——10.x/172.16-31.x/
// 192.168.x/127.x/169.254.x（含云 metadata 169.254.169.254）/localhost。
// 已知局限：无法防御 DNS rebinding（一个公网域名解析到内网 IP）——浏览器 fetch 不暴露"先解析
// 再连接"的中间步骤，JS 层做不到连接前二次校验解析结果。这跟 command-safety.ts 的黑名单式
// 拦截同一个安全姿态：挡常见/明显的攻击面，不是密不透风的沙箱。

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./types";

const FETCH_OUTPUT_LIMIT = 8000;
const FETCH_TIMEOUT_MS = 15000;

const paramsSchema = z.object({
  url: z.string().describe("要抓取的网页 URL（必须是 http/https）"),
});

type WebFetchParams = z.infer<typeof paramsSchema>;

const PRIVATE_HOSTNAMES = new Set(["localhost", "0.0.0.0"]);

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
  if (PRIVATE_HOSTNAMES.has(host) || host.endsWith(".local") || host === "::1") {
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

export const webFetchTool: ToolDefinition<WebFetchParams> = {
  name: "web_fetch",
  description: "抓取一个公网 URL 的内容并转成纯文本返回（只支持 http/https，拒绝内网/本机地址）。用于查资料、看文档、验证链接内容。",
  parameters: paramsSchema,
  readOnly: true,
  async execute(input): Promise<ToolResult> {
    const safety = assertSafeUrl(input.url);
    if (!safety.ok) {
      return { status: "denied", output: `已拦截：${safety.reason}` };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(input.url, { signal: controller.signal, redirect: "follow" });
      const contentType = res.headers.get("content-type") ?? "";
      const raw = await res.text();
      const body = contentType.includes("html") ? htmlToText(raw) : raw;
      const clipped = body.length > FETCH_OUTPUT_LIMIT ? body.slice(0, FETCH_OUTPUT_LIMIT) + "\n…(截断)" : body;
      return {
        status: res.ok ? "success" : "error",
        output: `${input.url}（HTTP ${res.status}）\n${clipped}`,
      };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        status: "error",
        output: aborted ? `请求超时（>${FETCH_TIMEOUT_MS / 1000}s）` : `请求失败：${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
