import { describe, it, expect } from "vitest";

import {
  DISTRIBUTION_OVERRIDES,
  getDistributionOverrideJson,
} from "@/lib/policy/distribution-overrides";

describe("distribution-overrides（发布通道数据源）", () => {
  it("默认是空对象——不覆盖任何策略，全部走 builtin", () => {
    expect(Object.keys(DISTRIBUTION_OVERRIDES)).toHaveLength(0);
  });

  it("未配置的 key → null（调用方兜底 builtin）", () => {
    expect(getDistributionOverrideJson("provider.error_patterns")).toBeNull();
    expect(getDistributionOverrideJson("message.router.markers")).toBeNull();
    expect(getDistributionOverrideJson("anything.else")).toBeNull();
  });
});
