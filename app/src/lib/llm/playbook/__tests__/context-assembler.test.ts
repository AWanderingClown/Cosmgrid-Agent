// 阶段5 Playbook — Context Assembler 加权/截断测试（2026-07-17 接线时补齐）。
// 用 Sync 版纯函数隔离 DB；加权维度的回归防线——rowToProjectMemory 曾漏映射
// confidence/helpful/harmful 字段导致这些加权全部空转。

import { describe, expect, it } from "vitest";
import { assemblePlaybookContextSync } from "../context-assembler";
import type { ProjectMemory } from "@/lib/db/memory";

function makeMemory(over: Partial<ProjectMemory>): ProjectMemory {
  return {
    id: "m-1",
    projectId: "p-1",
    kind: "context",
    title: "标题",
    content: "内容",
    importance: 50,
    tags: null,
    sourceKind: "manual",
    sourceRef: null,
    confidence: 0.5,
    status: "active",
    helpfulCount: 0,
    harmfulCount: 0,
    lastUsedAt: null,
    supersedesId: null,
    evidenceRefsJson: null,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    ...over,
  };
}

const input = { projectId: "p-1", taskKeywords: ["sqlite"] };

describe("assemblePlaybookContextSync", () => {
  it("tags 命中 taskKeywords 的条目排到前面", () => {
    const out = assemblePlaybookContextSync(
      [
        makeMemory({ id: "no-tag", title: "无标签" }),
        makeMemory({ id: "tagged", title: "有标签", tags: "sqlite,db" }),
      ],
      input,
    );
    expect(out[0]!.id).toBe("tagged");
  });

  it("harmful_count > 3 降权排到 helpful 条目之后", () => {
    const out = assemblePlaybookContextSync(
      [
        makeMemory({ id: "harmful", harmfulCount: 5 }),
        makeMemory({ id: "helpful", helpfulCount: 2 }),
      ],
      input,
    );
    expect(out[0]!.id).toBe("helpful");
    expect(out[1]!.id).toBe("harmful");
  });

  it("maxChars 截断：超预算的低分条目被丢弃，但至少保留 1 条", () => {
    const big = "x".repeat(300);
    const out = assemblePlaybookContextSync(
      [
        makeMemory({ id: "a", content: big, importance: 90 }),
        makeMemory({ id: "b", content: big, importance: 80 }),
        makeMemory({ id: "c", content: big, importance: 70 }),
      ],
      { ...input, maxChars: 650 },
    );
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("confidence 高的条目优先（同 importance）", () => {
    const out = assemblePlaybookContextSync(
      [
        makeMemory({ id: "low", confidence: 0.3 }),
        makeMemory({ id: "high", confidence: 0.95 }),
      ],
      input,
    );
    expect(out[0]!.id).toBe("high");
  });
});
