import { describe, expect, it } from "vitest";
import { getActiveAssistantModelLabel } from "../streaming-status";

describe("getActiveAssistantModelLabel", () => {
  it("uses the currently streaming assistant model before the selected model", () => {
    expect(
      getActiveAssistantModelLabel(
        [
          { role: "assistant", content: "old", modelLabel: "MiniMax-M3" },
          { role: "user", content: "continue" },
          { role: "assistant", content: "new", modelLabel: "deepseek-chat" },
        ],
        "MiniMax-M3",
      ),
    ).toBe("deepseek-chat");
  });

  it("falls back to the selected model when no assistant label exists", () => {
    expect(getActiveAssistantModelLabel([{ role: "user", content: "hi" }], "MiniMax-M3")).toBe("MiniMax-M3");
  });
});
