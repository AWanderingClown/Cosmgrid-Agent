import { describe, it, expect, vi } from "vitest";
import { askUserTool } from "../ask-user-tool";
import type { ToolContext } from "../types";

describe("askUserTool", () => {
  it("没有 ctx.askUser 时 denied，明确告知不要傻等", async () => {
    const ctx: ToolContext = { workspacePath: "" };
    const res = await askUserTool.execute(
      { question: "选哪个？", options: [{ label: "A" }, { label: "B" }] },
      ctx,
    );
    expect(res.status).toBe("denied");
    expect(res.output).toContain("不支持");
    expect(res.output).toContain("最佳判断");
  });

  it("有 ctx.askUser 时把 question/options 转发过去，返回用户选中的 label", async () => {
    const askUser = vi.fn().mockResolvedValue("Tavily（推荐）");
    const ctx: ToolContext = { workspacePath: "", askUser };
    const res = await askUserTool.execute(
      {
        question: "用哪个搜索后端？",
        options: [{ label: "Tavily（推荐）", description: "专为 agent 设计" }, { label: "Brave" }],
      },
      ctx,
    );
    expect(askUser).toHaveBeenCalledWith({
      question: "用哪个搜索后端？",
      options: [{ label: "Tavily（推荐）", description: "专为 agent 设计" }, { label: "Brave" }],
    });
    expect(res.status).toBe("success");
    expect(res.output).toContain("Tavily（推荐）");
  });

  it("只读工具，无副作用", () => {
    expect(askUserTool.readOnly).toBe(true);
  });
});
