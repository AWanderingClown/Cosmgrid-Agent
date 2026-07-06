import type { WorkRole } from "@/lib/api";
import { inferModelCapabilities } from "@/lib/llm/model-capabilities";
import { getPresetById, type ProviderPreset } from "@/lib/llm/provider-presets";
import type { ProviderTypeValue } from "./ProviderTypeSelect";

export const DEFAULT_BASE_URLS: Record<ProviderTypeValue, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  "openai-compatible": "",
  "claude-cli": "",
  "codex-cli": "",
};

export function isCliType(type: ProviderTypeValue): boolean {
  return type === "claude-cli" || type === "codex-cli";
}

export function getPresetForProviderType(type: ProviderTypeValue): ProviderPreset | undefined {
  if (type === "claude-cli") return getPresetById("claude-cli");
  if (type === "codex-cli") return getPresetById("codex-cli");
  return undefined;
}

export function inferRolesForModel(modelName: string): WorkRole[] {
  return modelName.trim() ? inferModelCapabilities(modelName).workRoles : ["main_chat"];
}
