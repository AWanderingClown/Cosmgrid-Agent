import { describe, it, expect } from "vitest";
import {
  detectModelTier,
  inferModelCapabilities,
  scoreModelForRole,
  pickBestModelForRole,
  autoAssignModels,
  type ScorableModel,
} from "../model-capabilities";

describe("detectModelTier", () => {
  it("旗舰模型识别", () => {
    expect(detectModelTier("claude-opus-4-8")).toBe("flagship");
    expect(detectModelTier("gemini-2.5-pro")).toBe("flagship");
    expect(detectModelTier("o3")).toBe("flagship");
    expect(detectModelTier("deepseek-r1")).toBe("flagship");
  });

  it("均衡模型识别", () => {
    expect(detectModelTier("claude-sonnet-4-6")).toBe("balanced");
    expect(detectModelTier("gpt-4o")).toBe("balanced");
    expect(detectModelTier("gemini-2.0-flash")).toBe("balanced");
    expect(detectModelTier("deepseek-v3")).toBe("balanced");
  });

  it("轻量模型识别（变体优先于家族）", () => {
    expect(detectModelTier("gpt-4o-mini")).toBe("fast");
    expect(detectModelTier("claude-haiku-4-5")).toBe("fast");
    expect(detectModelTier("gemini-2.0-flash-lite")).toBe("fast");
  });

  it("认不出的模型返回 unknown", () => {
    expect(detectModelTier("my-custom-proxy-model")).toBe("unknown");
  });
});

describe("inferModelCapabilities", () => {
  it("旗舰模型推理类得分最高", () => {
    const cap = inferModelCapabilities("claude-opus-4-8");
    expect(cap.tier).toBe("flagship");
    expect(cap.capabilityScore.planning).toBeGreaterThan(cap.capabilityScore.testing!);
    expect(cap.workRoles).toContain("planning");
    expect(cap.workRoles).toContain("review");
  });

  it("轻量模型 testing 得分高于 planning", () => {
    const cap = inferModelCapabilities("gpt-4o-mini");
    expect(cap.capabilityScore.testing).toBeGreaterThan(cap.capabilityScore.planning!);
  });

  it("认不出的模型至少能做主对话和兜底", () => {
    const cap = inferModelCapabilities("some-random-model");
    expect(cap.tier).toBe("unknown");
    expect(cap.workRoles).toEqual(["main_chat", "general"]);
  });

  it("覆盖 WORK_ROLES 全集", () => {
    const cap = inferModelCapabilities("gpt-4o");
    expect(cap.capabilityScore.frontend).toBeDefined();
    expect(cap.capabilityScore.ios).toBeDefined();
    expect(cap.capabilityScore.modeling).toBeDefined();
  });
});

const opus: ScorableModel = {
  id: "opus",
  name: "claude-opus-4-8",
  capabilityScore: null,
  workRoles: JSON.stringify(["planning", "review"]),
};
const haiku: ScorableModel = {
  id: "haiku",
  name: "claude-haiku-4-5",
  capabilityScore: null,
  workRoles: JSON.stringify(["testing"]),
};
const sonnet: ScorableModel = {
  id: "sonnet",
  name: "claude-sonnet-4-6",
  capabilityScore: null,
  workRoles: JSON.stringify(["frontend", "backend"]),
};

describe("scoreModelForRole", () => {
  it("用户勾过的角色获得加权", () => {
    const withRole = scoreModelForRole(opus, "planning"); // workRoles 含 planning
    const fresh = scoreModelForRole(
      { ...opus, workRoles: JSON.stringify([]) },
      "planning",
    );
    expect(withRole).toBe(fresh + 5);
  });

  it("优先使用已存的 capabilityScore", () => {
    const m: ScorableModel = {
      id: "x",
      name: "claude-haiku-4-5",
      capabilityScore: JSON.stringify({ planning: 99 }),
      workRoles: JSON.stringify([]),
    };
    expect(scoreModelForRole(m, "planning")).toBe(99);
  });

  it("坏的 capabilityScore JSON 不抛错，回退到名字推断", () => {
    const m: ScorableModel = {
      id: "x",
      name: "gpt-4o",
      capabilityScore: "{ not valid json",
      workRoles: JSON.stringify([]),
    };
    expect(() => scoreModelForRole(m, "planning")).not.toThrow();
    expect(scoreModelForRole(m, "planning")).toBeGreaterThan(0);
  });
});

describe("pickBestModelForRole", () => {
  it("规划角色选旗舰模型", () => {
    const best = pickBestModelForRole("planning", [haiku, opus, sonnet]);
    expect(best?.id).toBe("opus");
  });

  it("测试角色选轻量模型", () => {
    const best = pickBestModelForRole("testing", [opus, haiku, sonnet]);
    expect(best?.id).toBe("haiku");
  });

  it("无候选返回 null", () => {
    expect(pickBestModelForRole("planning", [])).toBeNull();
  });
});

describe("autoAssignModels", () => {
  it("为每个角色分配最优模型", () => {
    const map = autoAssignModels(["planning", "testing", "frontend"], [opus, haiku, sonnet]);
    expect(map.get("planning")).toBe("opus");
    expect(map.get("testing")).toBe("haiku");
    expect(map.get("frontend")).toBe("sonnet");
  });

  it("无候选模型时该角色被跳过", () => {
    const map = autoAssignModels(["planning"], []);
    expect(map.has("planning")).toBe(false);
  });
});
