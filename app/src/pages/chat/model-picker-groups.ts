// 模型下拉的分组逻辑（纯函数，独立于 ChatHeader 渲染，便于单测）。
//
// 背景：CLI 订阅供应商（claude-cli/codex-cli）一个供应商下可能挂多个真实模型
// （Sonnet/Opus/Haiku 这种档位），而 API 供应商（MiniMax/DeepSeek...）目前都只挂一个模型。
// 直接把所有模型摊平成一个下拉，CLI 那几档一多，列表就爆炸。这里按供应商分组：
// 只有 1 个模型的供应商仍然扁平展示（不多一层点击，维持原有体验）；
// 2 个以上模型的供应商折叠成二级菜单，顶层显示供应商短名，二级列出各档位模型。

import type { ModelListItem } from "@/lib/api";

export interface FlatModelEntry {
  kind: "flat";
  model: ModelListItem;
}

export interface GroupedModelEntry {
  kind: "group";
  providerId: string;
  label: string;
  models: ModelListItem[];
}

export type ModelPickerEntry = FlatModelEntry | GroupedModelEntry;

/**
 * 已知供应商类型的下拉分组短标签。provider.name 是给「模型供应商」管理页看的全称
 * （如 "Claude Code (CLI 订阅)"），这里单独定义菜单里用的短名，两边互不影响。
 * 未知类型（普通 API 供应商）落回 provider.name 本身。
 */
const GROUP_LABEL_BY_PROVIDER_TYPE: Record<string, string> = {
  "claude-cli": "Claude",
  "codex-cli": "Codex",
};

/** 首字母大写（防止 displayName 缺失时 fallback 到小写的 model.name） */
export function capitalizeFirstLetter(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** 按供应商分组，保留模型原始出现顺序（首次出现即分配分组位置） */
export function groupModelsForPicker(models: readonly ModelListItem[]): ModelPickerEntry[] {
  const providerOrder: string[] = [];
  const byProvider = new Map<string, ModelListItem[]>();
  for (const model of models) {
    if (!byProvider.has(model.providerId)) {
      byProvider.set(model.providerId, []);
      providerOrder.push(model.providerId);
    }
    byProvider.get(model.providerId)!.push(model);
  }

  return providerOrder.map((providerId): ModelPickerEntry => {
    const group = byProvider.get(providerId)!;
    if (group.length === 1) {
      return { kind: "flat", model: group[0]! };
    }
    const providerType = group[0]!.provider?.type ?? "";
    const label = GROUP_LABEL_BY_PROVIDER_TYPE[providerType] ?? group[0]!.provider?.name ?? "";
    return { kind: "group", providerId, label, models: group };
  });
}
