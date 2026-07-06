import { describe, expect, it } from "vitest";
import { applyPromptCompression } from "../prompt-compression";
import type { ChatMsg } from "@/lib/llm/context-compressor";

const messages: ChatMsg[] = [
  { role: "system", content: "规则" },
  { role: "user", content: "第一轮问题 ".repeat(3000) },
  { role: "assistant", content: "第一轮回答 ".repeat(3000) },
  { role: "user", content: "第二轮问题 ".repeat(3000) },
  { role: "assistant", content: "第二轮回答 ".repeat(3000) },
  { role: "user", content: "第三轮问题 ".repeat(3000) },
  { role: "assistant", content: "第三轮回答 ".repeat(3000) },
];

describe("applyPromptCompression", () => {
  it("returns the original prompt and no stats when disabled", () => {
    const result = applyPromptCompression({
      enabled: false,
      messages,
      modelName: "tiny-model",
      contextWindow: 100,
      noticeText: (count) => `已压缩 ${count} 条`,
    });

    expect(result.messages).toBe(messages);
    expect(result.compressionStats).toBeNull();
  });

  it("returns compression stats when smart compression trims history", () => {
    const result = applyPromptCompression({
      enabled: true,
      messages,
      modelName: "tiny-model",
      contextWindow: null,
      noticeText: (count) => `已压缩 ${count} 条`,
    });

    expect(result.messages.length).toBeLessThan(messages.length + 1);
    expect(result.compressionStats?.beforeTokens).toBeGreaterThan(result.compressionStats?.afterTokens ?? 0);
  });
});
