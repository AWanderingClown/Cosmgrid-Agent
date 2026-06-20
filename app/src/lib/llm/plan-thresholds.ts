// Token Plan 阈值检查（v0.4.3）
// 解析 warningThresholds 字段 + 算出"用量级别"（充足 / 接近耗尽 / 已耗尽 / 超阈值）
// 让 App.tsx 能在用户每次进 app / 完成 chat 后给提示

import { type TokenPlan } from "@/lib/db";

/** 用量级别 */
export type UsageLevel = "ok" | "warn" | "critical" | "exhausted";

/** 阈值配置（warningThresholds 字段反序列化形态） */
export interface PlanThresholds {
  /** 0-1，使用率达到此值触发"warn"提示（默认 0.8） */
  warn: number;
  /** 0-1，使用率达到此值触发"critical"提示（默认 0.95） */
  critical: number;
}

/** 默认阈值（warningThresholds 为空时用） */
const DEFAULT_THRESHOLDS: PlanThresholds = { warn: 0.8, critical: 0.95 };

/**
 * 解析 warningThresholds JSON 字符串，坏数据回退默认。
 * 用户在 TokenPlan 页配置时存的是 JSON（如 `{"warn":0.7,"critical":0.9}`），
 * 解析失败不要炸，给个兜底继续工作。
 */
export function parsePlanThresholds(json: string | null | undefined): PlanThresholds {
  if (!json) return DEFAULT_THRESHOLDS;
  try {
    const obj = JSON.parse(json) as unknown;
    if (obj && typeof obj === "object") {
      const o = obj as Record<string, unknown>;
      return {
        warn: typeof o.warn === "number" && o.warn > 0 && o.warn < 1 ? o.warn : DEFAULT_THRESHOLDS.warn,
        critical:
          typeof o.critical === "number" && o.critical > 0 && o.critical < 1
            ? o.critical
            : DEFAULT_THRESHOLDS.critical,
      };
    }
    return DEFAULT_THRESHOLDS;
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

/** 给一个 plan 算当前级别（纯函数，便于单测） */
export function planUsageLevel(
  plan: Pick<TokenPlan, "usedQuota" | "totalQuota" | "warningThresholds">,
): UsageLevel {
  if (!plan.totalQuota || plan.totalQuota <= 0) return "ok"; // 没设总额度就不评估
  const ratio = plan.usedQuota / plan.totalQuota;
  if (ratio >= 1) return "exhausted";
  const t = parsePlanThresholds(plan.warningThresholds);
  if (ratio >= t.critical) return "critical";
  if (ratio >= t.warn) return "warn";
  return "ok";
}

/** 给 UI 用的提示文案 + 颜色（v0.7 i18n 化：用 i18n key 替代硬编码中文） */
export function levelPresentation(level: UsageLevel): {
  labelKey: string;
  variant: "default" | "secondary" | "destructive";
} {
  switch (level) {
    case "exhausted":
      return { labelKey: "tokenPlans.status.exhausted", variant: "destructive" };
    case "critical":
      return { labelKey: "tokenPlans.status.critical", variant: "destructive" };
    case "warn":
      return { labelKey: "tokenPlans.status.warn", variant: "secondary" };
    case "ok":
      return { labelKey: "tokenPlans.status.ok", variant: "default" };
  }
}
