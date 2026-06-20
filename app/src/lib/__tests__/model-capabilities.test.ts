// model-capabilities 纯逻辑单测：能力档位识别 + 回退链排序（痛点 1）
import { describe, it, expect } from "vitest";
import {
  detectModelTier,
  scoreModelForRole,
  pickBestModelForRole,
  rankFallbackModels,
  type RankableModel,
} from "../llm/model-capabilities";

describe("detectModelTier 能力档位识别", () => {
  it("轻量变体优先判 fast（mini/haiku/flash-lite）", () => {
    expect(detectModelTier("gpt-4o-mini")).toBe("fast");
    expect(detectModelTier("claude-3-haiku")).toBe("fast");
    expect(detectModelTier("gemini-2.0-flash-lite")).toBe("fast");
  });

  it("旗舰判 flagship（opus/o1/pro/reasoner）", () => {
    expect(detectModelTier("claude-opus-4-8")).toBe("flagship");
    expect(detectModelTier("o1-preview")).toBe("flagship");
    expect(detectModelTier("gemini-2.5-pro")).toBe("flagship");
    expect(detectModelTier("deepseek-reasoner")).toBe("flagship");
  });

  it("中端判 balanced（sonnet/4o/gemini/glm/kimi）", () => {
    expect(detectModelTier("claude-sonnet-4-6")).toBe("balanced");
    expect(detectModelTier("gpt-4o")).toBe("balanced");
    expect(detectModelTier("glm-4-plus")).toBe("balanced");
  });

  it("完全认不出的给 unknown，绝不抛错", () => {
    expect(detectModelTier("totally-made-up-model-xyz")).toBe("unknown");
  });

  it("短标记按词匹配，不会让 mini 命中 geMINI、pro 命中 proxy", () => {
    // gemini 含 "mini" 子串，但 mini 是短标记按词匹配 → 不应判成 fast
    expect(detectModelTier("gemini-1.5")).toBe("balanced");
  });
});

// 构造一个可排序模型；用 capabilityScore JSON 锁定分数，workRoles 留空避免 +5 加权干扰
function model(id: string, providerId: string, mainChatScore: number): RankableModel {
  return {
    id,
    name: id,
    providerId,
    capabilityScore: JSON.stringify({ main_chat: mainChatScore }),
    workRoles: "[]",
  };
}

describe("rankFallbackModels 回退链排序（痛点 1）", () => {
  const primary = { id: "p", providerId: "provA" };
  // a2 与主模型同厂、分最高；b1/b2 是另一家
  const candidates: RankableModel[] = [
    model("p", "provA", 99), // 主模型自己也混在列表里
    model("a2", "provA", 95), // 同厂高分
    model("b1", "provB", 80), // 换厂低分
    model("b2", "provB", 90), // 换厂高分
  ];

  it("排除主模型自己", () => {
    const ranked = rankFallbackModels(primary, candidates, "main_chat");
    expect(ranked.map((m) => m.id)).not.toContain("p");
  });

  it("优先换厂：换厂的排在同厂前面，哪怕同厂分更高", () => {
    const ranked = rankFallbackModels(primary, candidates, "main_chat");
    // b2(换厂90) / b1(换厂80) 应排在 a2(同厂95) 前面
    expect(ranked.map((m) => m.id)).toEqual(["b2", "b1", "a2"]);
  });

  it("同一换厂档内，能力分高的在前", () => {
    const ranked = rankFallbackModels(primary, candidates, "main_chat");
    expect(ranked.indexOf(ranked.find((m) => m.id === "b2")!)).toBeLessThan(
      ranked.indexOf(ranked.find((m) => m.id === "b1")!),
    );
  });

  it("截断到 limit", () => {
    expect(rankFallbackModels(primary, candidates, "main_chat", 1).map((m) => m.id)).toEqual(["b2"]);
    expect(rankFallbackModels(primary, candidates, "main_chat", 0)).toEqual([]);
  });

  it("没有候选时返回空数组，不抛错", () => {
    expect(rankFallbackModels(primary, [], "main_chat")).toEqual([]);
    // 列表里只有主模型自己 → 排除后为空
    expect(rankFallbackModels(primary, [model("p", "provA", 99)], "main_chat")).toEqual([]);
  });
});

describe("scoreModelForRole / pickBestModelForRole 仍工作（回归保护）", () => {
  it("用户明确勾过该角色的模型有 +5 加权", () => {
    const tagged = { id: "x", name: "x", capabilityScore: JSON.stringify({ main_chat: 70 }), workRoles: JSON.stringify(["main_chat"]) };
    const plain = { id: "y", name: "y", capabilityScore: JSON.stringify({ main_chat: 70 }), workRoles: "[]" };
    expect(scoreModelForRole(tagged, "main_chat")).toBe(75);
    expect(scoreModelForRole(plain, "main_chat")).toBe(70);
    expect(pickBestModelForRole("main_chat", [plain, tagged])?.id).toBe("x");
  });
});
