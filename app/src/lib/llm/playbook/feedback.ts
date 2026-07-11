// Harness 工程实施计划 阶段5 — Memory Feedback 三件套。
//
// `recordMemoryHelpful / recordMemoryHarmful / recordMemoryUsed`：StreamCallbacks 调，
// 底层调 projectMemories 8 个扩展方法。错误降级：旁路 try/catch + console.error，
// 不阻塞主对话流（与 applyOutcomeForLatest outcome-tracker.ts:25 同模式）。

import { projectMemories } from "@/lib/db/memory";

/** 错误降级包装：失败时 console.error 但不抛错（playbook 是观测面） */
async function safeRun(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[playbook] ${label} 失败：`, err instanceof Error ? err.message : String(err));
  }
}

export async function recordMemoryHelpful(memoryId: string): Promise<void> {
  await safeRun("recordMemoryHelpful", () => projectMemories.incrementHelpful(memoryId));
}

export async function recordMemoryHarmful(memoryId: string): Promise<void> {
  await safeRun("recordMemoryHarmful", () => projectMemories.incrementHarmful(memoryId));
}

export async function recordMemoryUsed(memoryId: string): Promise<void> {
  await safeRun("recordMemoryUsed", () => projectMemories.touchLastUsed(memoryId));
}

/** 批量版本：context-assembler 一次注入多条 memory 时调用 */
export async function recordMemoriesUsed(memoryIds: string[]): Promise<void> {
  if (memoryIds.length === 0) return;
  await safeRun("recordMemoriesUsed", async () => {
    for (const id of memoryIds) {
      await projectMemories.touchLastUsed(id);
    }
  });
}