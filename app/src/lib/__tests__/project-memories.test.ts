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

  it("memory kind label 完整", async () => {
    const db = await import("../db");
    expect(db.MEMORY_KIND_LABEL.decision).toBe("决策");
    expect(db.MEMORY_KIND_LABEL.lesson).toBe("经验教训");
    expect(db.MEMORY_KIND_LABEL.context).toBe("背景上下文");
    expect(db.MEMORY_KIND_LABEL.preference).toBe("偏好");
    expect(db.MEMORY_KIND_LABEL.other).toBe("其他");
  });
});
