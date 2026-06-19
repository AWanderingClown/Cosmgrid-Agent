import { describe, it, expect } from "vitest";
import { parsePlanThresholds, planUsageLevel, levelPresentation } from "../plan-thresholds";

describe("parsePlanThresholds", () => {
  it("null/undefined → 默认 {warn:0.8, critical:0.95}", () => {
    expect(parsePlanThresholds(null)).toEqual({ warn: 0.8, critical: 0.95 });
    expect(parsePlanThresholds(undefined)).toEqual({ warn: 0.8, critical: 0.95 });
  });

  it("有效 JSON 解析", () => {
    expect(parsePlanThresholds('{"warn":0.7,"critical":0.9}')).toEqual({ warn: 0.7, critical: 0.9 });
  });

  it("坏 JSON → 默认", () => {
    expect(parsePlanThresholds("not json")).toEqual({ warn: 0.8, critical: 0.95 });
  });

  it("字段非数字或越界 → 字段级兜底", () => {
    expect(parsePlanThresholds('{"warn":"x","critical":0.9}')).toEqual({
      warn: 0.8,
      critical: 0.9,
    });
    expect(parsePlanThresholds('{"warn":0,"critical":0.9}')).toEqual({
      warn: 0.8,
      critical: 0.9,
    });
    expect(parsePlanThresholds('{"warn":1.5,"critical":0.9}')).toEqual({
      warn: 0.8,
      critical: 0.9,
    });
  });
});

describe("planUsageLevel", () => {
  it("无 totalQuota → ok", () => {
    expect(planUsageLevel({ usedQuota: 999, totalQuota: null, warningThresholds: null })).toBe("ok");
    expect(planUsageLevel({ usedQuota: 999, totalQuota: 0, warningThresholds: null })).toBe("ok");
  });

  it("ratio < warn (0.8) → ok", () => {
    expect(planUsageLevel({ usedQuota: 50, totalQuota: 100, warningThresholds: null })).toBe("ok");
  });

  it("ratio = 0.85 (>= warn 0.8) → warn", () => {
    expect(planUsageLevel({ usedQuota: 85, totalQuota: 100, warningThresholds: null })).toBe("warn");
  });

  it("ratio = 0.95 (>= critical 0.95) → critical", () => {
    expect(planUsageLevel({ usedQuota: 95, totalQuota: 100, warningThresholds: null })).toBe("critical");
  });

  it("ratio >= 1 → exhausted", () => {
    expect(planUsageLevel({ usedQuota: 100, totalQuota: 100, warningThresholds: null })).toBe(
      "exhausted",
    );
    expect(planUsageLevel({ usedQuota: 120, totalQuota: 100, warningThresholds: null })).toBe(
      "exhausted",
    );
  });

  it("自定义阈值生效", () => {
    // critical=0.5, used=0.6 → critical
    expect(
      planUsageLevel({ usedQuota: 6, totalQuota: 10, warningThresholds: '{"warn":0.3,"critical":0.5}' }),
    ).toBe("critical");
  });
});

describe("levelPresentation", () => {
  it("返回 label + variant", () => {
    expect(levelPresentation("ok").label).toBe("充足");
    expect(levelPresentation("warn").variant).toBe("secondary");
    expect(levelPresentation("exhausted").variant).toBe("destructive");
  });
});
