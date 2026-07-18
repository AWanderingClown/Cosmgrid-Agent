// PlaybookPanel 的纯函数部分——冲突配对分组 + pending 过滤。
// 抽出来是因为这两块是 2026-07-17 二轮复检抓到 MEDIUM 的核心逻辑（同一老条目被多条
// candidate 同时冲突时只显示第一条、pending 写库中的条目被 refetch 复活），拆成纯函数
// 才能独立写回归测试（项目没有 React Testing Library，遵循已有 derive-*.ts 惯例）。

import type { ProjectMemory } from "@/lib/db/memory";

export interface PlaybookDisputeGroup {
  disputed: ProjectMemory;
  /** 与该 disputed 条目冲突的 candidate（可能不止一条，同一批事件可产生多条各自冲突同一老条目的 candidate） */
  linkedCandidates: ProjectMemory[];
}

export interface PlaybookGrouping {
  groups: PlaybookDisputeGroup[];
  /** 不属于任何冲突配对的独立候选条目 */
  plainCandidates: ProjectMemory[];
}

/**
 * 按 candidate.supersedesId === disputed.id 把候选条目分组挂到对应的 disputed 老条目下。
 * 用 filter 而非 find：同一老条目可能被多条 candidate 同时冲突，只取第一条会让其余的
 * 变成没有 UI 路径可以裁决的孤儿行（2026-07-17 二轮复检 MEDIUM）。
 */
export function groupPlaybookCandidates(
  disputed: ProjectMemory[],
  candidates: ProjectMemory[],
): PlaybookGrouping {
  const groups = disputed.map((d) => ({
    disputed: d,
    linkedCandidates: candidates.filter((c) => c.supersedesId === d.id),
  }));
  const linkedIds = new Set(groups.flatMap((g) => g.linkedCandidates.map((c) => c.id)));
  const plainCandidates = candidates.filter((c) => !linkedIds.has(c.id));
  return { groups, plainCandidates };
}

/**
 * 从 refetch 结果里排除正在写库途中的条目 id——防止用户刚裁决完、写库还没落地时
 * 一次 refetch 把旧状态读出来重新塞回列表（2026-07-17 二轮复检 MEDIUM）。
 */
export function excludePendingIds(items: ProjectMemory[], pendingIds: ReadonlySet<string>): ProjectMemory[] {
  if (pendingIds.size === 0) return items;
  return items.filter((m) => !pendingIds.has(m.id));
}
