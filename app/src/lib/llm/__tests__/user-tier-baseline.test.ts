import { describe, it, expect } from "vitest";
import { scoreByUserBaseline, USER_TIER_BASELINE } from "../user-tier-baseline";

describe("scoreByUserBaseline", () => {
  it("Opus4.8 全能 → 任何角色都 95", () => {
    expect(scoreByUserBaseline("claude-opus-4-8", "planning")).toBe(95);
    expect(scoreByUserBaseline("Opus4.8", "backend")).toBe(95);
    expect(scoreByUserBaseline("opus-4-8", "review")).toBe(95);
  });

  it("minimax-m3 擅长 backend/review → 70；不擅长的 planning 打折 42", () => {
    expect(scoreByUserBaseline("MiniMax-M3", "backend")).toBe(70);
    expect(scoreByUserBaseline("MiniMax-M3", "review")).toBe(70);
    expect(scoreByUserBaseline("MiniMax-M3", "planning")).toBe(42); // 70*0.6
  });

  it("Gemini3.1 擅长 frontend → 86；不擅长的 backend 打折", () => {
    expect(scoreByUserBaseline("gemini-3.1", "frontend")).toBe(86);
    expect(scoreByUserBaseline("gemini-3.1", "backend")).toBe(52); // 86*0.6
  });

  it("deepseek-chat 模糊匹配 deepseek-v4 → backend 80", () => {
    expect(scoreByUserBaseline("deepseek-chat", "backend")).toBe(80);
  });

  it("agnes-2.0-flash 匹配 agnes（strongRoles 空）→ 60*0.6=36", () => {
    expect(scoreByUserBaseline("agnes-2.0-flash", "backend")).toBe(36);
  });

  it("Qwen3.7 没用过（strongRoles 空）→ 70*0.6=42", () => {
    expect(scoreByUserBaseline("qwen-3.7", "backend")).toBe(42);
  });

  it("不在表里的模型 → null（调用方 fallback 名字查表）", () => {
    expect(scoreByUserBaseline("some-random-model", "backend")).toBeNull();
  });

  it("大小写不敏感", () => {
    expect(scoreByUserBaseline("MINIMAX-M3", "backend")).toBe(70);
    expect(scoreByUserBaseline("Opus4.8", "planning")).toBe(95);
  });
});

describe("USER_TIER_BASELINE 完整性", () => {
  it("用户给的 11 个模型都在", () => {
    const names = ["opus", "gpt5.5", "gemini3.1", "glm5.2", "deepseek", "kimi", "minimax-m3", "qwen3.7", "minimax-m2.5", "glm-5", "agnes"];
    for (const n of names) {
      expect(USER_TIER_BASELINE.some((e) => e.aliases.some((a) => a.includes(n) || n.includes(a)))).toBe(true);
    }
  });
});
