import { describe, it, expect, beforeEach, vi } from "vitest";

// 模拟"发布方在 distribution 层给 provider 错误表配了一个新 provider"（§5.2 K2 数据源）。
// 这样端到端验证：distribution 文件源 → PolicyStore.get(distribution) → hydrate → getProviderPatterns。
vi.mock("@/lib/policy/distribution-overrides", () => ({
  getDistributionOverrideJson: (key: string) =>
    key === "provider.error_patterns"
      ? JSON.stringify({
          mockprovider: {
            rateLimitStatusCodes: [429, 9001],
            authStatusCodes: [401],
            contextOverflowStatusCodes: [413],
            modelNotFoundStatusCodes: [404],
            rateLimitKeywords: ["额度不足"],
            authKeywords: ["鉴权失败"],
            contextOverflowKeywords: ["上下文过长"],
            modelNotFoundKeywords: ["模型不存在"],
          },
        })
      : null,
}));

import {
  getProviderPatterns,
  hydrateProviderErrorRules,
  providerErrorRulesPolicy,
  _resetProviderErrorHydration,
  DEFAULT_ERROR_PATTERNS,
  PROVIDER_ERROR_PATTERNS,
} from "@/lib/policy/provider-error-rules";

describe("provider-error-rules 引擎化", () => {
  beforeEach(() => {
    _resetProviderErrorHydration();
  });

  describe("getProviderPatterns builtin 兜底（未 hydrate）", () => {
    it("已知 provider 返回其真实 builtin 规则", () => {
      // MiniMax 是 probe 实测回填过的，builtin 里必然有它专属的自定义 code
      expect(getProviderPatterns("MiniMax")).toBe(PROVIDER_ERROR_PATTERNS.MiniMax);
      expect(getProviderPatterns("MiniMax").authStatusCodes).toContain(1004);
    });

    it("未知 provider → DEFAULT", () => {
      expect(getProviderPatterns("nope")).toBe(DEFAULT_ERROR_PATTERNS);
    });

    it("openai 系 → DEFAULT（走 OpenAI 标准错误体）", () => {
      expect(getProviderPatterns("openai")).toBe(DEFAULT_ERROR_PATTERNS);
      expect(getProviderPatterns("openai-compatible")).toBe(DEFAULT_ERROR_PATTERNS);
    });

    it("providerType 未传 → DEFAULT", () => {
      expect(getProviderPatterns(undefined)).toBe(DEFAULT_ERROR_PATTERNS);
    });
  });

  describe("PolicyDefinition parse / merge", () => {
    it("parse 校验合法 override", () => {
      const raw = JSON.stringify({
        foo: {
          rateLimitStatusCodes: [429],
          authStatusCodes: [401],
          contextOverflowStatusCodes: [413],
          modelNotFoundStatusCodes: [404],
          rateLimitKeywords: ["a"],
          authKeywords: ["b"],
          contextOverflowKeywords: ["c"],
          modelNotFoundKeywords: ["d"],
        },
      });
      const parsed = providerErrorRulesPolicy.parse(raw);
      expect(parsed.foo!.rateLimitStatusCodes).toEqual([429]);
    });

    it("parse 拒绝缺字段的结构", () => {
      const raw = JSON.stringify({ foo: { rateLimitStatusCodes: [429] } });
      expect(() => providerErrorRulesPolicy.parse(raw)).toThrow();
    });

    it("merge：override 逐 provider 覆盖，未出现的沿用 builtin", () => {
      const override = {
        newone: PROVIDER_ERROR_PATTERNS.MiniMax!, // 借用一份合法结构
      };
      const merged = providerErrorRulesPolicy.merge(PROVIDER_ERROR_PATTERNS, override);
      expect(merged.newone).toBeDefined(); // 新增的在
      expect(merged.MiniMax).toBe(PROVIDER_ERROR_PATTERNS.MiniMax); // 原有的仍在
    });
  });

  describe("hydrate 端到端（distribution 文件源 → 生效）", () => {
    it("hydrate 前，distribution 新增的 provider 还识别不到（走 DEFAULT）", () => {
      expect(getProviderPatterns("mockprovider")).toBe(DEFAULT_ERROR_PATTERNS);
    });

    it("hydrate 后，distribution 层配置的 mockprovider 生效", async () => {
      await hydrateProviderErrorRules();
      const p = getProviderPatterns("mockprovider");
      expect(p).not.toBe(DEFAULT_ERROR_PATTERNS);
      expect(p.rateLimitStatusCodes).toContain(9001);
      expect(p.rateLimitKeywords).toContain("额度不足");
    });

    it("hydrate 后，builtin 的 provider 仍在（override 不删 builtin）", async () => {
      await hydrateProviderErrorRules();
      expect(getProviderPatterns("MiniMax").authStatusCodes).toContain(1004);
    });

    it("hydrate 幂等：重复调用不重复合并", async () => {
      await hydrateProviderErrorRules();
      await hydrateProviderErrorRules();
      expect(getProviderPatterns("mockprovider").rateLimitStatusCodes).toContain(9001);
    });
  });
});
