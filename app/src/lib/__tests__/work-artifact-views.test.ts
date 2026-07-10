import { describe, expect, it } from "vitest";
import type { ToolExecutionRow } from "@/lib/db";
import { deriveToolCallViews } from "../work-artifact-views";

function row(over: Partial<ToolExecutionRow>): ToolExecutionRow {
  return {
    id: "r1",
    projectId: null,
    conversationId: "c1",
    messageId: null,
    toolName: "read",
    input: "{}",
    output: "",
    status: "success",
    userConfirmed: false,
    reversible: false,
    durationMs: 10,
    createdAt: "2026-06-29T00:00:00.000Z",
    resultJson: null,
    errorCode: null,
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

  it("展开详情输出人话摘要，不暴露原始 JSON", () => {
    const [view] = deriveToolCallViews([
      row({
        toolName: "write",
        input: JSON.stringify({ file_path: "docs/plan.md", content: "one\ntwo" }),
        output: "written",
        status: "success",
      }),
    ]);

    expect(view!.detailFull).toContain("动作：写入 plan.md（2 行）");
    expect(view!.detailFull).toContain("结果：已完成");
    expect(view!.detailFull).not.toContain('"input"');
    expect(view!.detailFull).not.toContain('"content"');
  });

  // ============ 2.1 修复（2026-07-02）：reversible 字段透传到 ToolCallView ============

  it("write 成功 + reversible=true → view.reversible=true（git 快照成功）", () => {
    const [view] = deriveToolCallViews([
      row({
        toolName: "write",
        input: JSON.stringify({ file_path: "src/index.ts", content: "x" }),
        status: "success",
        reversible: true,
      }),
    ]);
    expect(view!.reversible).toBe(true);
  });

  it("write 成功 + reversible=false → view.reversible=false（非 git 仓库静默失效）", () => {
    // 2.1 修复的关键场景：非 git 仓库时 UI 必须显示 ⚠️ 无法撤销
    const [view] = deriveToolCallViews([
      row({
        toolName: "write",
        input: JSON.stringify({ file_path: "/tmp/new-project/file.ts", content: "x" }),
        status: "success",
        reversible: false,
      }),
    ]);
    expect(view!.reversible).toBe(false);
  });

  it("edit 成功 + reversible=true → view.reversible=true", () => {
    const [view] = deriveToolCallViews([
      row({
        toolName: "edit",
        input: JSON.stringify({ file_path: "src/x.ts", old_string: "a", new_string: "b" }),
        status: "success",
        reversible: true,
      }),
    ]);
    expect(view!.reversible).toBe(true);
  });

  it("只读工具（read/grep/glob/git_read）reversible 字段透传但 UI 不显示", () => {
    // 字段透传仍发生（reversible 字段统一透传），但 ToolCallCard 不消费只读工具的 reversible
    const views = deriveToolCallViews([
      row({ id: "r1", toolName: "read", input: JSON.stringify({ file_path: "x" }), reversible: false }),
      row({ id: "g1", toolName: "grep", input: JSON.stringify({ pattern: "y" }), reversible: false }),
    ]);
    expect(views[0]!.reversible).toBe(false);
    expect(views[1]!.reversible).toBe(false);
  });

  it("write 失败 + reversible=false → view.reversible=false（失败时不可撤销）", () => {
    const [view] = deriveToolCallViews([
      row({
        toolName: "write",
        input: JSON.stringify({ file_path: "x" }),
        status: "error",
        reversible: false,
      }),
    ]);
    expect(view!.reversible).toBe(false);
  });
});
