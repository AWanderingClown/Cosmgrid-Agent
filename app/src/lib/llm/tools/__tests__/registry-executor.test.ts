// registry + executor 单测（v0.7 阶段4）
import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../../../db", () => ({
  toolExecutions: { create: mocks.create },
}));

import { ToolRegistry } from "../registry";
import { executeTool, MAX_OUTPUT_CHARS } from "../executor";
import type { AnyToolDefinition, ToolContext } from "../types";

const ctx: ToolContext = { workspacePath: "/ws", projectId: "p1", conversationId: "c1" };

function echoTool(over: Partial<AnyToolDefinition> = {}): AnyToolDefinition {
  return {
    name: "echo",
    description: "回显输入",
    parameters: z.object({ text: z.string() }),
    readOnly: true,
    execute: async (input: { text: string }) => ({ status: "success", output: input.text }),
    ...over,
  };
}

describe("ToolRegistry", () => {
  it("注册 + 查找 + 列表", () => {
    const r = new ToolRegistry();
    r.register(echoTool());
    expect(r.has("echo")).toBe(true);
    expect(r.get("echo")!.name).toBe("echo");
    expect(r.list()).toHaveLength(1);
    expect(r.size).toBe(1);
  });

  it("同名重复注册抛错", () => {
    const r = new ToolRegistry();
    r.register(echoTool());
    expect(() => r.register(echoTool())).toThrow(/已注册/);
  });

  it("listReadOnly 只返回只读工具", () => {
    const r = new ToolRegistry();
    r.registerAll([echoTool(), echoTool({ name: "write", readOnly: false })]);
    expect(r.listReadOnly().map((t) => t.name)).toEqual(["echo"]);
  });
});

describe("executeTool", () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.create.mockResolvedValue("exec-id");
  });

  it("成功执行并落审计", async () => {
    const res = await executeTool(echoTool(), { text: "hello" }, ctx);
    expect(res.status).toBe("success");
    expect(res.output).toBe("hello");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ toolName: "echo", status: "success" });
  });

  it("zod 校验失败 → status=error，不执行", async () => {
    const exec = vi.fn();
    const res = await executeTool(echoTool({ execute: exec }), { text: 123 }, ctx);
    expect(res.status).toBe("error");
    expect(exec).not.toHaveBeenCalled();
  });

  it("execute 抛错 → status=error 且仍落审计", async () => {
    const tool = echoTool({ execute: async () => { throw new Error("boom"); } });
    const res = await executeTool(tool, { text: "x" }, ctx);
    expect(res.status).toBe("error");
    expect(res.output).toMatch(/boom/);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("超长输出截断到上限", async () => {
    const big = "a".repeat(MAX_OUTPUT_CHARS + 500);
    const tool = echoTool({ execute: async () => ({ status: "success", output: big }) });
    await executeTool(tool, { text: "x" }, ctx);
    const recordedOutput = mocks.create.mock.calls[0]![0].output as string;
    expect(recordedOutput.length).toBeLessThan(big.length);
    expect(recordedOutput).toMatch(/truncated/);
  });

  it("审计写入失败不影响工具结果", async () => {
    mocks.create.mockRejectedValue(new Error("db down"));
    const res = await executeTool(echoTool(), { text: "ok" }, ctx);
    expect(res.status).toBe("success");
  });

  it("写工具成功记 userConfirmed=true", async () => {
    const tool = echoTool({ name: "write", readOnly: false });
    await executeTool(tool, { text: "x" }, ctx);
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ userConfirmed: true });
  });
});
