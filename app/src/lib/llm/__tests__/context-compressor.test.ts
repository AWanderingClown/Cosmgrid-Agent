// context-compressor 单测（v0.9 阶段7：长上下文裁剪）
import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  estimateMessagesTokens,
  compressHistory,
  type ChatMsg,
} from "../context-compressor";

function msg(role: ChatMsg["role"], content: string): ChatMsg {
  return { role, content };
}

describe("estimateTokens", () => {
  it("约 chars/3", () => {
    expect(estimateTokens("abcdef")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("compressHistory", () => {
  it("在预算内不压缩", () => {
    const ms = [msg("user", "hi"), msg("assistant", "hello")];
    const r = compressHistory(ms, { maxTokens: 1000 });
    expect(r.compressed).toBe(false);
    expect(r.droppedCount).toBe(0);
    expect(r.messages).toHaveLength(2);
  });

  it("超预算时裁掉较早消息并插省略提示", () => {
    const ms: ChatMsg[] = [];
    for (let i = 0; i < 20; i++) ms.push(msg("user", "x".repeat(300)));
    const r = compressHistory(ms, { maxTokens: 500, minRecent: 2 });
    expect(r.compressed).toBe(true);
    expect(r.droppedCount).toBeGreaterThan(0);
    // 第一条应是省略提示（system）
    expect(r.messages[0]!.role).toBe("system");
    // 保留的非提示消息数 + 裁掉数 = 原始数
    const keptNonNotice = r.messages.filter((m) => m.role !== "system").length;
    expect(keptNonNotice + r.droppedCount).toBe(20);
  });

  it("system 消息始终保留", () => {
    const ms: ChatMsg[] = [msg("system", "你是助手")];
    for (let i = 0; i < 20; i++) ms.push(msg("user", "y".repeat(300)));
    const r = compressHistory(ms, { maxTokens: 500, minRecent: 2 });
    const systems = r.messages.filter((m) => m.role === "system");
    // 原 system + 省略提示
    expect(systems.some((m) => m.content === "你是助手")).toBe(true);
  });

  it("至少保留 minRecent 条最近消息", () => {
    const ms: ChatMsg[] = [];
    for (let i = 0; i < 20; i++) ms.push(msg("user", "z".repeat(3000)));
    const r = compressHistory(ms, { maxTokens: 100, minRecent: 3 });
    const kept = r.messages.filter((m) => m.role !== "system");
    expect(kept.length).toBeGreaterThanOrEqual(3);
  });

  it("不修改入参", () => {
    const ms = [msg("user", "a"), msg("assistant", "b")];
    const copy = JSON.parse(JSON.stringify(ms));
    compressHistory(ms, { maxTokens: 1 });
    expect(ms).toEqual(copy);
  });

  it("保留的是最新的消息（顺序不乱）", () => {
    const ms: ChatMsg[] = [];
    for (let i = 0; i < 10; i++) ms.push(msg("user", `m${i}-${"x".repeat(300)}`));
    const r = compressHistory(ms, { maxTokens: 400, minRecent: 2 });
    const last = r.messages[r.messages.length - 1]!;
    expect(last.content.startsWith("m9")).toBe(true);
  });

  it("自定义省略提示文案", () => {
    const ms: ChatMsg[] = [];
    for (let i = 0; i < 20; i++) ms.push(msg("user", "x".repeat(300)));
    const r = compressHistory(ms, { maxTokens: 500, minRecent: 2, noticeText: (n) => `省略了${n}条` });
    expect(r.messages[0]!.content).toMatch(/省略了\d+条/);
  });
});

describe("estimateMessagesTokens", () => {
  it("含每条 4 token 开销", () => {
    expect(estimateMessagesTokens([msg("user", "abc")])).toBe(estimateTokens("abc") + 4);
  });
});
