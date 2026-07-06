import { describe, it, expect } from "vitest";
import { todoWriteTool } from "../todo-tool";
import type { ToolContext } from "../types";

const ctx: ToolContext = { workspacePath: "" };

describe("todoWriteTool", () => {
  it("按状态渲染出对应的复选框标记", async () => {
    const res = await todoWriteTool.execute(
      {
        todos: [
          { content: "读代码", status: "completed" },
          { content: "写测试", status: "in_progress" },
          { content: "提交", status: "pending" },
        ],
      },
      ctx,
    );
    expect(res.status).toBe("success");
    expect(res.output).toBe("[x] 读代码\n[~] 写测试\n[ ] 提交");
  });

  it("空列表返回已清空提示，不报错", async () => {
    const res = await todoWriteTool.execute({ todos: [] }, ctx);
    expect(res.status).toBe("success");
    expect(res.output).toContain("清空");
  });

  it("只读工具，不需要 ctx.confirm", () => {
    expect(todoWriteTool.readOnly).toBe(true);
  });
});
