import { describe, it, expect } from "vitest";
import { deriveArtifacts } from "../work-artifacts";
import type { ToolExecutionRow } from "@/lib/db";

/** 造一行 tool_execution，字段可覆盖 */
function row(over: Partial<ToolExecutionRow>): ToolExecutionRow {
  return {
    id: "r1",
    projectId: null,
    conversationId: "c1",
    toolName: "write",
    input: "",
    output: "",
    status: "success",
    userConfirmed: true,
    reversible: false,
    durationMs: 10,
    createdAt: "2026-06-25T10:00:00Z",
    ...over,
  };
}

describe("deriveArtifacts", () => {
  it("write → file 工件（路径 + content 全量）", () => {
    const out = deriveArtifacts([
      row({
        toolName: "write",
        input: JSON.stringify({ file_path: "app/a.tsx", content: "export const x = 1;" }),
        output: "已写入",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "file",
      title: "app/a.tsx",
      detail: "export const x = 1;",
      action: "write",
      status: "success",
    });
  });

  it("edit → file 工件（路径 + new_string 片段）", () => {
    const out = deriveArtifacts([
      row({
        toolName: "edit",
        input: JSON.stringify({
          file_path: "app/b.ts",
          old_string: "foo",
          new_string: "bar",
        }),
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "file",
      title: "app/b.ts",
      detail: "bar",
      action: "edit",
    });
  });

  it("bash → terminal 工件（命令 + output）", () => {
    const out = deriveArtifacts([
      row({
        toolName: "bash",
        input: JSON.stringify({ command: "pnpm test" }),
        output: "all passed",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "terminal",
      title: "pnpm test",
      detail: "all passed",
      action: "bash",
    });
  });

  it("read / glob / grep / git_read 只读工具被跳过", () => {
    const out = deriveArtifacts([
      row({ id: "r1", toolName: "read", input: JSON.stringify({ file_path: "x" }) }),
      row({ id: "r2", toolName: "glob", input: JSON.stringify({ pattern: "**/*.ts" }) }),
      row({ id: "r3", toolName: "grep", input: JSON.stringify({ pattern: "foo" }) }),
      row({ id: "r4", toolName: "git_read", input: JSON.stringify({}) }),
    ]);
    expect(out).toEqual([]);
  });

  it("失败的 write 也展示，标 error 状态", () => {
    const out = deriveArtifacts([
      row({
        toolName: "write",
        status: "error",
        input: JSON.stringify({ file_path: "x", content: "c" }),
        output: "权限不足",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe("error");
  });

  it("denied 状态映射成 denied", () => {
    const out = deriveArtifacts([
      row({ toolName: "bash", status: "denied", input: JSON.stringify({ command: "rm -rf /" }) }),
    ]);
    expect(out[0]?.status).toBe("denied");
  });

  it("input JSON 残缺/非法不崩——降级显示", () => {
    const out = deriveArtifacts([
      row({ toolName: "write", input: "{不是合法JSON" }),
    ]);
    expect(out).toHaveLength(1);
    // file_path 取不到，降级用 toolName 兜底；content 取不到为空串
    expect(out[0]?.title).toBe("write");
    expect(out[0]?.detail).toBe("");
  });

  it("未知工具不臆造工件，跳过", () => {
    const out = deriveArtifacts([
      row({ toolName: "some_unknown_tool", input: JSON.stringify({}) }),
    ]);
    expect(out).toEqual([]);
  });

  it("混合时间正序保留：write → bash → edit 顺序不变", () => {
    const out = deriveArtifacts([
      row({ id: "w1", toolName: "write", createdAt: "t1", input: JSON.stringify({ file_path: "a", content: "1" }) }),
      row({ id: "b1", toolName: "bash", createdAt: "t2", input: JSON.stringify({ command: "ls" }) }),
      row({ id: "e1", toolName: "edit", createdAt: "t3", input: JSON.stringify({ file_path: "b", old_string: "x", new_string: "y" }) }),
      row({ id: "r1", toolName: "read", createdAt: "t0", input: JSON.stringify({ file_path: "z" }) }),
    ]);
    expect(out.map((a) => a.id)).toEqual(["w1", "b1", "e1"]);
    // 只读的 r1 被剔除，其余保持原顺序
  });

  // ====== 阶段 G：html kind 派生 + diffOld 字段 ======

  it("write .html 文件 → kind=html（review M2/M4：仅 success + SVG 一并 + 大小写不敏感）", () => {
    const out = deriveArtifacts([
      row({ id: "h1", toolName: "write", status: "success", input: JSON.stringify({ file_path: "index.html", content: "<h1>Hi</h1>" }) }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("html");
    expect(out[0]!.title).toBe("index.html");
  });

  it("write .SVG 文件 → kind=html（review M4：SVG 一并归 html）", () => {
    const out = deriveArtifacts([
      row({ id: "h2", toolName: "write", status: "success", input: JSON.stringify({ file_path: "logo.SVG", content: "<svg/>" }) }),
    ]);
    expect(out[0]!.kind).toBe("html");
  });

  it("write .ts 文件 → 仍是 file kind（不被误判 html）", () => {
    const out = deriveArtifacts([
      row({ id: "f1", toolName: "write", status: "success", input: JSON.stringify({ file_path: "app.ts", content: "export const a = 1;" }) }),
    ]);
    expect(out[0]!.kind).toBe("file");
  });

  it("edit 含 old_string + status=success → diffOld 字段有值（review M2 闸门）", () => {
    const out = deriveArtifacts([
      row({
        id: "e1",
        toolName: "edit",
        status: "success",
        input: JSON.stringify({ file_path: "a.ts", old_string: "old", new_string: "new" }),
      }),
    ]);
    expect(out[0]!.diffOld).toBe("old");
  });

  it("edit status=error → 不派生 diffOld（review M2 闸门，避免误画 diff）", () => {
    const out = deriveArtifacts([
      row({
        id: "e2",
        toolName: "edit",
        status: "error",
        input: JSON.stringify({ file_path: "a.ts", old_string: "old", new_string: "new" }),
      }),
    ]);
    expect(out[0]!.diffOld).toBeUndefined();
  });

  it("write .html + status=error → 降级 file kind（review M2 闸门，仅 success 派生 html）", () => {
    const out = deriveArtifacts([
      row({ id: "h3", toolName: "write", status: "error", input: JSON.stringify({ file_path: "x.html", content: "" }) }),
    ]);
    expect(out[0]!.kind).toBe("file");
  });
});
