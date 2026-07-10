// llm/tools/memory-tool 单测（task #11 补齐覆盖率）
// memory-tool.ts 当前 branches 0%；下面覆盖：denied 路径（无 confirm / 用户拒绝 / projectId 缺失 /
// create 抛错）和 success 路径（默认 kind、importance、tags join / 不传 tags、custom 字段）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "../types";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

vi.mock("@/lib/db/memory", () => ({
  projectMemories: {
    create: mocks.create,
  },
}));

vi.mock("@/lib/db", () => ({
  conversations: {
    getById: mocks.getById,
  },
}));

// requireApproval 直接走 ctx.confirm，不依赖任何 side-effect，不需要 mock
import { rememberTool } from "../memory-tool";

function ctxWith(confirm?: (req: unknown) => Promise<boolean>): ToolContext {
  return {
    workspacePath: "/ws",
    confirm: confirm as ToolContext["confirm"],
    conversationId: "conv-1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({
    id: "mem-1",
    projectId: "proj-1",
    kind: "decision",
    title: "用 Tauri 打包",
    content: "Tauri 2 不需要 Node 运行时",
    importance: 70,
    tags: "tui,deployment",
  });
  mocks.getById.mockResolvedValue({ id: "conv-1", projectId: "proj-1" });
});

describe("rememberTool — 确认闸", () => {
  it("confirm 通道未提供 → 直接 denied", async () => {
    const r = await rememberTool.execute(
      { title: "x", content: "y" },
      ctxWith(undefined) as ToolContext,
    );
    expect(r.status).toBe("denied");
  });

  it("用户拒绝 → denied（注意：被拒绝时不会落到 projectMemories.create）", async () => {
    const r = await rememberTool.execute(
      { title: "x", content: "y" },
      ctxWith(async () => false) as ToolContext,
    );
    expect(r.status).toBe("denied");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("rememberTool — projectId 解析", () => {
  it("ctx.conversationId 缺失 → 不能挂项目，返回 error", async () => {
    const ctx: ToolContext = {
      workspacePath: "/ws",
      confirm: async () => true,
      // 无 conversationId
    };
    const r = await rememberTool.execute({ title: "x", content: "y" }, ctx);
    expect(r.status).toBe("error");
    expect(r.output).toContain("未绑定项目");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("conversations.getById 返回无 projectId → error", async () => {
    mocks.getById.mockResolvedValue({ id: "conv-1", projectId: null });
    const r = await rememberTool.execute(
      { title: "x", content: "y" },
      ctxWith(async () => true) as ToolContext,
    );
    expect(r.status).toBe("error");
    expect(r.output).toContain("未绑定项目");
  });

  it("conversations.getById 抛错（catch 兜底） → 也算 projectId 缺失", async () => {
    mocks.getById.mockRejectedValue(new Error("db broken"));
    const r = await rememberTool.execute(
      { title: "x", content: "y" },
      ctxWith(async () => true) as ToolContext,
    );
    expect(r.status).toBe("error");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("rememberTool — 入参与持久化", () => {
  it("kind / importance 未传时用默认值（kind='other', importance=50）", async () => {
    const r = await rememberTool.execute(
      { title: "默认字段", content: "内容" },
      ctxWith(async () => true) as ToolContext,
    );
    expect(r.status).toBe("success");
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "other",
        importance: 50,
        title: "默认字段",
        content: "内容",
        tags: null,
      }),
    );
  });

  it("kind/importance 自定义 + tags 数组合并成逗号串", async () => {
    const r = await rememberTool.execute(
      {
        title: "具体决策",
        content: "详情",
        kind: "decision",
        importance: 80,
        tags: ["tui", "deployment", "bug"],
      },
      ctxWith(async () => true) as ToolContext,
    );
    expect(r.status).toBe("success");
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "decision",
        importance: 80,
        tags: "tui,deployment,bug",
      }),
    );
  });

  it("tags 空数组不写入 → tags:null", async () => {
    const r = await rememberTool.execute(
      { title: "t", content: "c", tags: [] },
      ctxWith(async () => true) as ToolContext,
    );
    expect(r.status).toBe("success");
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ tags: null }));
  });

  it("projectMemories.create 抛错 → 返回 error，结果提示但不抛出", async () => {
    mocks.create.mockRejectedValue(new Error("schema constraint"));
    const r = await rememberTool.execute(
      { title: "t", content: "c" },
      ctxWith(async () => true) as ToolContext,
    );
    expect(r.status).toBe("error");
    expect(r.output).toContain("schema constraint");
  });
});

describe("rememberTool — 成功结果输出", () => {
  it("返回文案包含标题 / kind / importance（让模型能看到落库产物）", async () => {
    // success 输出取自 memory 返回值的 title/kind/importance，mock 与入参对齐
    mocks.create.mockImplementation(async (data: { title: string; kind: string; importance: number }) => ({
      id: "mem-1",
      projectId: "proj-1",
      kind: data.kind,
      title: data.title,
      content: "",
      importance: data.importance,
      tags: null,
    }));
    const r = await rememberTool.execute(
      { title: "已完成", content: "内容", kind: "lesson", importance: 75 },
      ctxWith(async () => true) as ToolContext,
    );
    expect(r.output).toContain("已完成");
    expect(r.output).toContain("lesson");
    expect(r.output).toContain("75");
  });
});
