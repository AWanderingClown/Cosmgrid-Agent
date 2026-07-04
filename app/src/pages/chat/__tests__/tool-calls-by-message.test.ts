import { describe, expect, it } from "vitest";
import { deriveToolCallsByMessage } from "../tool-calls-by-message";
import type { ChatMessage } from "../types";
import type { ToolCallView } from "@/lib/work-artifact-views";

function msg(over: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: "assistant",
    content: "",
    createdAt: "2026-07-04T00:00:00.000Z",
    ...over,
  };
}

function tc(over: Partial<ToolCallView> & { id: string }): ToolCallView {
  return {
    toolName: "write",
    status: "success",
    shortSummary: "写入 x",
    summaryKey: "write",
    summaryVars: {},
    detailPreview: "",
    detailFull: "",
    createdAt: "2026-07-04T00:00:00.000Z",
    durationMs: 10,
    messageId: null,
    ...over,
  };
}

describe("deriveToolCallsByMessage", () => {
  it("有真实 messageId 时精确归属，不受时间戳先后影响", () => {
    const messages = [msg({ id: "m1", createdAt: "2026-07-04T00:00:00.000Z" })];
    const calls = [tc({ id: "c1", messageId: "m1", createdAt: "2026-07-04T00:05:00.000Z" })];
    const map = deriveToolCallsByMessage(messages, calls);
    expect(map.get("m1")).toEqual(calls);
  });

  it("回归用例：最新消息本轮 0 真实工具调用时，不会认领之后其他节点产生的工具调用", () => {
    // 对应真实事故：编排模式下，可见消息 m1（自己没调用工具）之后，另一个后台节点
    // 用不同的 messageId 真的执行了一次 write（真实存在），旧的时间戳窗口实现会因为
    // "最新消息右边界是 null" 把这次不相关的工具调用错误地显示在 m1 身上。
    const messages = [msg({ id: "m1", createdAt: "2026-07-04T00:00:00.000Z" })];
    const calls = [
      tc({ id: "c1", messageId: "m2-background-node", createdAt: "2026-07-04T00:05:00.000Z" }),
    ];
    const map = deriveToolCallsByMessage(messages, calls);
    expect(map.get("m1")).toEqual([]);
  });

  it("messageId 缺失的历史行仍走时间戳窗口兜底（向后兼容旧数据）", () => {
    const messages = [
      msg({ id: "m1", createdAt: "2026-07-04T00:00:00.000Z" }),
      msg({ id: "m2", role: "user", createdAt: "2026-07-04T00:10:00.000Z" }),
      msg({ id: "m3", createdAt: "2026-07-04T00:20:00.000Z" }),
    ];
    const calls = [
      tc({ id: "legacy-1", messageId: null, createdAt: "2026-07-04T00:05:00.000Z" }),
      tc({ id: "legacy-2", messageId: null, createdAt: "2026-07-04T00:25:00.000Z" }),
    ];
    const map = deriveToolCallsByMessage(messages, calls);
    expect(map.get("m1")).toEqual([calls[0]]);
    expect(map.get("m3")).toEqual([calls[1]]);
  });

  it("真实 messageId 行和历史兜底行可以在同一批数据里共存，互不污染", () => {
    const messages = [
      msg({ id: "m1", createdAt: "2026-07-04T00:00:00.000Z" }),
      msg({ id: "m2", createdAt: "2026-07-04T00:10:00.000Z" }),
    ];
    const calls = [
      // m2 自己真实调用的工具（有 messageId）
      tc({ id: "real", messageId: "m2", createdAt: "2026-07-04T00:01:00.000Z" }),
      // 一条 messageId 缺失的历史行，时间戳落在 m1 的窗口内
      tc({ id: "legacy", messageId: null, createdAt: "2026-07-04T00:02:00.000Z" }),
    ];
    const map = deriveToolCallsByMessage(messages, calls);
    expect(map.get("m1")).toEqual([calls[1]]);
    expect(map.get("m2")).toEqual([calls[0]]);
  });

  it("跳过非 assistant 消息和 receipt 消息", () => {
    const messages = [
      msg({ id: "u1", role: "user" }),
      msg({ id: "r1", kind: "receipt" }),
      msg({ id: "m1" }),
    ];
    const map = deriveToolCallsByMessage(messages, []);
    expect(map.has("u1")).toBe(false);
    expect(map.has("r1")).toBe(false);
    expect(map.get("m1")).toEqual([]);
  });
});
