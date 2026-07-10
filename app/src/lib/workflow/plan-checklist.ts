// 2026-07-10 移植 OMO boulder-state/plan-checklist.ts 思路 ——「不到 100% 不停」的清单解析。
//
// 病根：readDesktopPlanForExecution 只把 PLAN.md 原文整段塞进 system 消息，模型看不到
// "这份方案到底做完了几成、下一项具体是什么"，容易在清单还有未勾选项时就说"全部完成"。
//
// 解法：数方案文件里的 `- [ ]`（未完成）/ `- [x]`（已完成）checkbox，算出总数/完成数/剩余数，
// 并揪出第一条未完成任务的文案，拼成一句状态注入 system 消息——不是自动化循环（这是聊天
// 界面，续跑靠下一轮用户消息驱动，不是无人值守 agent loop），而是让模型每轮都知道真实进度，
// 不能在清单没勾完时就自称完工。
//
// 与 OMO 原版的差异：原版要求 `## TODOs` / `## Final Verification Wave` 这两个精确标题才计入
// 统计（针对它自己的 ulw-loop 模板）；我们的 PLAN.md 没有强制模板，所以沿用 OMO 同一份算法里
// 「文档里根本没有这两个标题时，退化为统计全文所有 checkbox」的分支——这样普通自由格式的方案
// 文件（用户/AI 随手写的 - [ ] 清单）也能被正确识别，不需要用户先学一套标题约定。

export interface PlanChecklist {
  total: number;
  completed: number;
  remaining: number;
  nextTaskLabel: string | null;
}

const CHECKBOX_PATTERN = /^- \[[ xX]\] /;
const UNCHECKED_PATTERN = /^- \[ \] /;
const TODO_HEADING = "TODOs";
const FINAL_VERIFICATION_HEADING = "Final Verification Wave";

function parseLevelTwoHeading(line: string): string | null {
  if (!line.startsWith("## ")) return null;
  return line.slice("## ".length).trim();
}

function isCountedHeading(heading: string): boolean {
  return heading === TODO_HEADING || heading === FINAL_VERIFICATION_HEADING;
}

function hasCountedSectionHeading(line: string): boolean {
  const heading = parseLevelTwoHeading(line);
  return heading !== null && isCountedHeading(heading);
}

function emptyChecklist(): PlanChecklist {
  return { completed: 0, remaining: 0, total: 0, nextTaskLabel: null };
}

/** 从方案 markdown 正文里数 checkbox，算出完成进度 + 下一条未完成任务文案。 */
export function parsePlanChecklist(markdown: string): PlanChecklist {
  if (!markdown) return emptyChecklist();

  const lines = markdown.split(/\r?\n/);
  const hasCountedSections = lines.some(hasCountedSectionHeading);
  let remaining = 0;
  let total = 0;
  let nextTaskLabel: string | null = null;
  // 文档里根本没有 "## TODOs" / "## Final Verification Wave" 这两个标题时，
  // 整篇文档都算数（自由格式方案文件的兜底行为）。
  let isCountedSection = !hasCountedSections;

  for (const line of lines) {
    const heading = parseLevelTwoHeading(line);
    if (heading !== null) {
      isCountedSection = isCountedHeading(heading);
    }
    if (!isCountedSection || !CHECKBOX_PATTERN.test(line)) continue;

    total += 1;
    if (!UNCHECKED_PATTERN.test(line)) continue;

    remaining += 1;
    if (nextTaskLabel === null) {
      nextTaskLabel = line.slice("- [ ] ".length);
    }
  }

  return { completed: total - remaining, remaining, total, nextTaskLabel };
}

/** 把清单进度拼成给模型看的一句话状态（没有任何 checkbox 时返回 null，不硬凑）。 */
export function formatPlanChecklistStatus(checklist: PlanChecklist): string | null {
  if (checklist.total === 0) return null;
  if (checklist.remaining === 0) {
    return `方案清单进度：${checklist.completed}/${checklist.total} 项已全部完成。`;
  }
  const nextLine = checklist.nextTaskLabel ? `下一项未完成：${checklist.nextTaskLabel}` : "";
  return [
    `方案清单进度：${checklist.completed}/${checklist.total} 项已完成，还剩 ${checklist.remaining} 项未完成。`,
    nextLine,
    "清单没有全部勾选完成前，不要向用户宣称任务已经完工；继续推进下一项未完成任务，除非用户明确要求暂停或改变范围。",
  ]
    .filter(Boolean)
    .join("\n");
}
