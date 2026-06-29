import { describe, expect, it } from "vitest";
import type { ToolExecutionRow } from "@/lib/db";
import { deriveToolCallViews } from "../work-artifact-views";

function row(over: Partial<ToolExecutionRow>): ToolExecutionRow {
  return {
    id: "r1",
    projectId: null,
    conversationId: "c1",
    toolName: "read",
    input: "{}",
    output: "",
    status: "success",
    userConfirmed: false,
    reversible: false,
    durationMs: 10,
    createdAt: "2026-06-29T00:00:00.000Z",
    ...over,
  };
}

describe("deriveToolCallViews", () => {
  it("保留 read / grep / glob 等只读工具步骤", () => {
    const views = deriveToolCallViews([
      row({ id: "read", toolName: "read", input: JSON.stringify({ file_path: "src/App.tsx" }) }),
      row({ id: "grep", toolName: "grep", input: JSON.stringify({ pattern: "TODO" }) }),
      row({ id: "glob", toolName: "glob", input: JSON.stringify({ pattern: "**/*.ts" }) }),
    ]);

    expect(views.map((v) => v.shortSummary)).toEqual([
      "读取 App.tsx",
      "搜索文本：TODO",
      "查找文件：**/*.ts",
    ]);
  });

  it("write 步骤显示文件名和行数", () => {
    const [view] = deriveToolCallViews([
      row({ toolName: "write", input: JSON.stringify({ file_path: "docs/a.md", content: "a\nb\nc" }) }),
    ]);
    expect(view!.shortSummary).toBe("写入 a.md（3 行）");
  });

  it("非法 JSON 不会打断步骤派生", () => {
    const [view] = deriveToolCallViews([row({ toolName: "bash", input: "{bad" })]);
    expect(view!.shortSummary).toBe("执行命令：命令");
  });
});
