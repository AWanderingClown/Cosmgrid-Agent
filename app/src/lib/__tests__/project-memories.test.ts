// ProjectMemory CRUD 单元测试（mock tauri-plugin-sql）
// 因为 tauri-plugin-sql 跑测试需要 Tauri runtime，这里直接 mock db 层
import { describe, it, expect } from "vitest";

describe("projectMemories schema 形状", () => {
  it("CRUD 导出在 db.ts 里有", async () => {
    const db = await import("../db");
    expect(db.projectMemories).toBeDefined();
    expect(typeof db.projectMemories.create).toBe("function");
    expect(typeof db.projectMemories.listByProject).toBe("function");
    expect(typeof db.projectMemories.searchAcrossProjects).toBe("function");
  });

  it("memoryKindLabel 翻译中文（v0.7 i18n 化：原 MEMORY_KIND_LABEL 常量已替换为函数）", async () => {
    const db = await import("../db");
    const tZh = (k: string) =>
      ({ "memoryKind.decision": "决策", "memoryKind.lesson": "经验教训", "memoryKind.context": "背景上下文", "memoryKind.preference": "偏好", "memoryKind.other": "其他" } as Record<string, string>)[k] ?? k;
    expect(db.memoryKindLabel("decision", tZh)).toBe("决策");
    expect(db.memoryKindLabel("lesson", tZh)).toBe("经验教训");
    expect(db.memoryKindLabel("context", tZh)).toBe("背景上下文");
    expect(db.memoryKindLabel("preference", tZh)).toBe("偏好");
    expect(db.memoryKindLabel("other", tZh)).toBe("其他");
  });
});
