// 厂商预设：选一个厂商 → 自动带出 providerType / baseUrl / 官网 / 默认模型，用户只需粘 API key。
//
// 解决的痛点：原来加 OpenAI 兼容厂商要手敲 baseUrl + 模型名，极易填错（如 DeepSeek 填 "deepseek" 而非真实模型名）。
// 现在选厂商即自动填，再配合 fetch-models 拉取真实模型列表，从根上杜绝填错。
//
// ⚠️ 产品原则：预设只是「便捷入口」，不是限制。用户永远能选「自定义」手动配任意厂商（绝不硬编码锁死某几家）。
// 所有 baseUrl 已逐个 curl 核实 /models 端点存在（401=路径正确），不是凭记忆写的。

import type { ProviderTypeValue } from "@/components/providers/ProviderTypeSelect";

export interface ProviderPreset {
  /** 稳定 id（也用于 i18n key 与图标） */
  id: string;
  /** 默认填入的供应商名称（用户可改） */
  name: string;
  /** 协议类型，决定调用方式 */
  providerType: ProviderTypeValue;
  /** 接口地址（CLI 类型留空，baseUrl 复用为可执行文件路径） */
  baseUrl: string;
  /** 官网 */
  website?: string;
  /** 去哪拿 API Key（UI 给个直达链接，省得用户翻官网） */
  apiKeyUrl?: string;
  /** 默认模型名：拉取真实列表前的占位/兜底（拉取成功后用真实列表覆盖） */
  defaultModel: string;
  /** 默认上下文窗口（粗略，用户可改） */
  defaultContextWindow: number;
  /** 是否支持「粘 key 后自动拉取模型列表」（CLI / 无 /models 的厂商为 false） */
  supportsModelFetch: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ===== 国内主流（全是 OpenAI 兼容，baseUrl + /models 已 curl 核实）=====
  {
    id: "deepseek",
    name: "DeepSeek",
    providerType: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    website: "https://www.deepseek.com",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    defaultModel: "deepseek-chat",
    defaultContextWindow: 128_000,
    supportsModelFetch: true,
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    providerType: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    website: "https://www.bigmodel.cn",
    apiKeyUrl: "https://www.bigmodel.cn/usercenter/proj-mgmt/apikeys",
    defaultModel: "glm-4.6",
    defaultContextWindow: 128_000,
    supportsModelFetch: true,
  },
  {
    id: "qwen",
    name: "通义千问 Qwen",
    providerType: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    website: "https://dashscope.aliyun.com",
    apiKeyUrl: "https://bailian.console.aliyun.com/?apiKey=1",
    defaultModel: "qwen-plus",
    defaultContextWindow: 131_072,
    supportsModelFetch: true,
  },
  {
    id: "kimi",
    name: "Kimi (Moonshot)",
    providerType: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    website: "https://www.moonshot.cn",
    apiKeyUrl: "https://platform.moonshot.cn/console/api-keys",
    defaultModel: "moonshot-v1-8k",
    defaultContextWindow: 128_000,
    supportsModelFetch: true,
  },
  {
    id: "minimax",
    name: "MiniMax",
    providerType: "openai-compatible",
    baseUrl: "https://api.minimaxi.com/v1",
    website: "https://www.minimaxi.com",
    apiKeyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    defaultModel: "MiniMax-Text-01",
    defaultContextWindow: 1_000_000,
    supportsModelFetch: true,
  },
  {
    // Agnes AI API Gateway（聚合网关，OpenAI 兼容）——base URL 来自官方文档并已 curl 核实 /models 端点
    id: "agnes",
    name: "Agnes AI",
    providerType: "openai-compatible",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    website: "https://agnes-ai.com",
    apiKeyUrl: "https://platform.agnes-ai.com/",
    defaultModel: "agnes-2.0-flash",
    defaultContextWindow: 128_000,
    supportsModelFetch: true,
  },

  // ===== 国外官方 =====
  {
    id: "openai",
    name: "OpenAI",
    providerType: "openai",
    baseUrl: "https://api.openai.com/v1",
    website: "https://openai.com",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-4o",
    defaultContextWindow: 128_000,
    supportsModelFetch: true,
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    providerType: "anthropic",
    baseUrl: "https://api.anthropic.com",
    website: "https://www.anthropic.com",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    defaultModel: "claude-opus-4-8",
    defaultContextWindow: 200_000,
    supportsModelFetch: true,
  },
  {
    id: "gemini",
    name: "Google Gemini",
    providerType: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    website: "https://ai.google.dev",
    apiKeyUrl: "https://aistudio.google.com/apikey",
    defaultModel: "gemini-2.5-pro",
    defaultContextWindow: 1_000_000,
    supportsModelFetch: true,
  },

  // ===== 本机 CLI 订阅（吃订阅额度，不填 key / url；baseUrl 复用为可执行文件路径，留空=系统 PATH）=====
  {
    id: "claude-cli",
    name: "Claude Code (CLI 订阅)",
    providerType: "claude-cli",
    baseUrl: "",
    website: "https://docs.claude.com/claude-code",
    defaultModel: "claude-opus-4-8",
    defaultContextWindow: 200_000,
    supportsModelFetch: false,
  },
  {
    id: "codex-cli",
    name: "Codex (CLI 订阅)",
    providerType: "codex-cli",
    baseUrl: "",
    website: "https://developers.openai.com/codex",
    defaultModel: "gpt-5.5-codex",
    defaultContextWindow: 256_000,
    supportsModelFetch: false,
  },
];

/** 按 id 取预设 */
export function getPresetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
