import { describe, expect, it } from "vitest";
import { getAssistantActivityLabel } from "@/pages/chat/streaming-status";

describe("getAssistantActivityLabel", () => {
  it("模型输出阶段显示回复中", () => {
    expect(getAssistantActivityLabel("streaming", "回复中", "正在自检")).toBe("回复中");
  });

  it("模型停字后的判定阶段显示正在自检，不再显示回复中", () => {
    expect(getAssistantActivityLabel("checking", "回复中", "正在自检")).toBe("正在自检");
  });
});
