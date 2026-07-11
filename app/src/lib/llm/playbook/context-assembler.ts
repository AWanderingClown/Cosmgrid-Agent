// Harness 工程实施计划 阶段5 — Context Assembler（检索 + 加权 + 截断）。
//
// `assemblePlaybookContext(input)`：从 project_memories 拿 active 条目，加权排序后截断到 maxChars。
//
// 加权模型（参考 scoreProjectMemoryHit retrieval-tuning.ts:41 + 阶段5 新增维度）：
// - tags 命中 input.taskKeywords 加权 +0.2
// - workspace 匹配 input.workspacePath 加权 +0.1
// - harmful_count > 3 降权 -0.3
// - helpful_count > 0 加权 +0.05
// - last_used_at 30 天内 +0.02
// - confidence 0.5-1.0 线性加权
// - importance 0-100 / 100（线性）
//
// 截断：返回 top 30 条 + 总字符 ≤ maxChars（默认 4000）

import { projectMemories, type ProjectMemory } from "@/lib/db/memory";
import type { AssemblePlaybookContextInput } from "./types";

const MAX_ITEMS = 30;
const DEFAULT_MAX_CHARS = 4000;
const RECENT_USED_DAYS = 30;
const RECENT_USED_MS = RECENT_USED_DAYS * 24 * 60 * 60 * 1000;
const HARMFUL_THRESHOLD = 3;

function scoreItem(item: ProjectMemory, input: AssemblePlaybookContextInput): number {
  let score = 0;
  // importance 0-100
  score += item.importance / 100;
  // confidence 0-1
  if (item.status === "active") score += item.confidence ?? 0.5;
  // tags 命中（ProjectMemory.tags 是 string | null —— DB 存 CSV）
  const itemTagsCsv = (item.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const matchedTags = input.taskKeywords.filter((kw) =>
    itemTagsCsv.some((t) => t.toLowerCase().includes(kw.toLowerCase())),
  );
  score += matchedTags.length * 0.2;
  // workspace 匹配
  if (input.workspacePath && (item.title.includes(input.workspacePath) || item.content.includes(input.workspacePath))) {
    score += 0.1;
  }
  // harmful_count 高的降权
  if ((item.harmfulCount ?? 0) > HARMFUL_THRESHOLD) {
    score -= 0.3;
  }
  // helpful_count 升权
  if ((item.helpfulCount ?? 0) > 0) {
    score += 0.05;
  }
  // last_used_at 30 天内
  if (item.lastUsedAt) {
    const ageMs = Date.now() - new Date(item.lastUsedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs < RECENT_USED_MS) {
      score += 0.02;
    }
  }
  return score;
}

export async function assemblePlaybookContext(
  input: AssemblePlaybookContextInput,
): Promise<ProjectMemory[]> {
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  const all = await projectMemories.listActiveByProject(input.projectId, 200);

  const scored = all
    .map((item) => ({ item, score: scoreItem(item, input) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ITEMS);

  const out: ProjectMemory[] = [];
  let chars = 0;
  for (const { item } of scored) {
    const itemChars = item.title.length + item.content.length + 4;
    if (chars + itemChars > maxChars && out.length > 0) break;
    out.push(item);
    chars += itemChars;
  }
  return out;
}

/** 同步版本（不入 DB，用于单测） */
export function assemblePlaybookContextSync(
  all: ProjectMemory[],
  input: AssemblePlaybookContextInput,
): ProjectMemory[] {
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  const scored = all
    .map((item) => ({ item, score: scoreItem(item, input) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ITEMS);
  const out: ProjectMemory[] = [];
  let chars = 0;
  for (const { item } of scored) {
    const itemChars = item.title.length + item.content.length + 4;
    if (chars + itemChars > maxChars && out.length > 0) break;
    out.push(item);
    chars += itemChars;
  }
  return out;
}