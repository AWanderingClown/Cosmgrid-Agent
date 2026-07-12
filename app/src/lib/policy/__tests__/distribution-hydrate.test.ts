import { describe, it, expect, beforeEach, vi } from "vitest";

// 模拟发布方在 distribution 层配置了 user-tier 基线 + debate marker（§5.2 K2 数据源）。
// 端到端验证：distribution 文件源 → PolicyStore.get(distribution) → hydrate → 同步消费函数生效。
vi.mock("@/lib/policy/distribution-overrides", () => ({
  getDistributionOverrideJson: (key: string) => {
    if (key === "model.user_tier_baseline") {
      return JSON.stringify([
        { aliases: ["zzz-mock-model"], score: 42, strongRoles: ["backend"] },
      ]);
    }
    if (key === "llm.debate_markers") {
      return JSON.stringify(["独一无二的对弈触发词xyz"]);
    }
    return null;
  },
}));

import {
  scoreByUserBaseline,
  hydrateUserTierBaseline,
  _resetUserTierHydration,
} from "@/lib/policy/user-tier-baseline";
import {
  getDebateMarkers,
  hydrateDebateMarkers,
  _resetDebateHydration,
} from "@/lib/policy/debate-markers";
import { shouldSuggestDebate } from "@/lib/llm/debate-suggester";

describe("distribution hydrate — user-tier + debate（复检补接）", () => {
  beforeEach(() => {
    _resetUserTierHydration();
    _resetDebateHydration();
  });

  describe("user-tier", () => {
    it("hydrate 前走 builtin：distribution 里的新 alias 查不到、builtin 的 opus 在", () => {
      expect(scoreByUserBaseline("zzz-mock-model", "backend")).toBeNull();
      expect(scoreByUserBaseline("opus-4-8", "backend")).not.toBeNull();
    });

    it("hydrate 后 distribution baseline 生效（override 语义整表替换）", async () => {
      await hydrateUserTierBaseline();
      expect(scoreByUserBaseline("zzz-mock-model", "backend")).toBe(42);
      // override 语义：整表替换 builtin，原 opus 不再在表里
      expect(scoreByUserBaseline("opus-4-8", "backend")).toBeNull();
    });

    it("hydrate 幂等", async () => {
      await hydrateUserTierBaseline();
      await hydrateUserTierBaseline();
      expect(scoreByUserBaseline("zzz-mock-model", "backend")).toBe(42);
    });
  });

  describe("debate", () => {
    it("hydrate 前用 builtin marker", () => {
      expect(getDebateMarkers()).toContain("架构");
    });

    it("hydrate 后 distribution marker 生效，且 shouldSuggestDebate 跟着变", async () => {
      await hydrateDebateMarkers();
      const markers = getDebateMarkers();
      expect(markers).toContain("独一无二的对弈触发词xyz");
      expect(markers).not.toContain("架构"); // override 整表替换
      expect(shouldSuggestDebate("请就 独一无二的对弈触发词xyz 帮我权衡")).toBe(true);
      expect(shouldSuggestDebate("这个架构方案怎么样")).toBe(false); // 旧 builtin marker 已不生效
    });
  });
});
