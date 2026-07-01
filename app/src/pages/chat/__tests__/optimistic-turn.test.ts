import { describe, expect, it } from "vitest";
import { createOptimisticUserTurn } from "../optimistic-turn";

describe("createOptimisticUserTurn", () => {
  it("builds the visible user turn before async persistence finishes", () => {
    const existing = [{ id: "a1", role: "assistant" as const, content: "旧回复" }];
    const turn = createOptimisticUserTurn({
      messages: existing,
      text: "看一下这个项目，我要对项目有全面的了解",
      attachments: [{ id: "folder-1", kind: "folder" as const, name: "Cosmgrid-Agent", path: "/repo" }],
      id: "u1",
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(turn.userMsg).toEqual({
      id: "u1",
      role: "user",
      content: "看一下这个项目，我要对项目有全面的了解",
      createdAt: "2026-07-01T00:00:00.000Z",
      attachments: [{ id: "folder-1", kind: "folder", name: "Cosmgrid-Agent", path: "/repo" }],
    });
    expect(turn.newMessages).toEqual([...existing, turn.userMsg]);
  });
});
