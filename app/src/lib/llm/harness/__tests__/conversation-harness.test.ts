import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listByConversation: vi.fn(),
  judgeFabrication: vi.fn(),
  classifyFabricationGate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  toolExecutions: {
    listByConversation: mocks.listByConversation,
  },
}));

vi.mock("../fabrication-judge", async () => {
  const actual = await vi.importActual<typeof import("../fabrication-judge")>("../fabrication-judge");
  return {
    ...actual,
    judgeFabrication: mocks.judgeFabrication,
    classifyFabricationGate: mocks.classifyFabricationGate,
  };
});

import { evaluateConversationHarness } from "../conversation-harness";

const model = { modelId: "judge-model" } as never;

describe("evaluateConversationHarness", () => {
  beforeEach(() => {
    mocks.listByConversation.mockReset();
    mocks.judgeFabrication.mockReset();
    mocks.classifyFabricationGate.mockReset().mockReturnValue("B");
  });

  it("硬校验先命中时，不再跑第二层裁判", async () => {
    mocks.listByConversation.mockResolvedValue([
      {
        id: "t1",
        toolName: "read",
        input: "/tmp/other.ts",
        output: "x",
        status: "ok",
        createdAt: new Date().toISOString(),
        messageId: "msg-1",
      },
    ]);

    const verdict = await evaluateConversationHarness({
      conversationId: "conv-1",
      content: "我读了 foo.ts，里面就是这样。",
      sinceIso: new Date().toISOString(),
      actualToolCallCount: 1,
      assistantMessageId: "msg-1",
      judgeModel: model,
    });

    expect(verdict?.unverifiedPaths.length).toBeGreaterThan(0);
    expect(mocks.judgeFabrication).not.toHaveBeenCalled();
  });

  it("硬校验干净且 B 档命中时，运行 fabrication judge 并回填 verdict", async () => {
    const now = new Date().toISOString();
    mocks.listByConversation.mockResolvedValue([
      {
        id: "t1",
        toolName: "bash",
        input: "SELECT count(*)",
        output: "2 rows",
        status: "ok",
        createdAt: now,
        messageId: "msg-2",
      },
    ]);
    mocks.judgeFabrication.mockResolvedValue({
      fabricated: true,
      confidence: 0.95,
      claimedActions: ["数据库命中 20 条"],
      reason: "工具输出是 2，回答却说 20。",
    });

    const verdict = await evaluateConversationHarness({
      conversationId: "conv-1",
      content: "我刚查了数据库，共 20 条记录，8ms 完成，命中如下，结果已经确认。",
      sinceIso: now,
      actualToolCallCount: 1,
      assistantMessageId: "msg-2",
      finishReason: "stop",
      judgeModel: model,
    });

    expect(mocks.judgeFabrication).toHaveBeenCalledTimes(1);
    expect(verdict?.fabricationSuspected?.claimedActions).toEqual(["数据库命中 20 条"]);
  });
});
