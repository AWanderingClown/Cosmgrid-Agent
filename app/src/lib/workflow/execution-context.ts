import type { FsAdapter } from "@/lib/llm/tools/fs-adapter";
import type { WorkflowSnapshot } from "./types";
import { formatPlanChecklistStatus, parsePlanChecklist } from "./plan-checklist";

const MAX_PLAN_CHARS = 12_000;

const PLAN_REFERENCE_RE =
  /(之前|刚刚|上面|桌面|PLAN\.md|plan\.md|这个方案|这份方案|那个方案|按.*方案|照.*方案|执行方案|开始执行|直接执行)/i;

function currentPhase(snapshot: WorkflowSnapshot): string {
  const node = snapshot.nodes.find((n) => n.id === snapshot.currentNodeId);
  return node?.phase ?? snapshot.status;
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function truncate(text: string, max = MAX_PLAN_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n…（方案内容过长，已截断）` : text;
}

export function referencesExistingPlan(text: string): boolean {
  return PLAN_REFERENCE_RE.test(text.trim());
}

export async function readDesktopPlanForExecution(args: {
  userText: string;
  desktopPath: string | null;
  fs: FsAdapter;
}): Promise<{ path: string; content: string } | null> {
  if (!args.desktopPath) return null;
  if (!referencesExistingPlan(args.userText)) return null;
  const path = joinPath(args.desktopPath, "PLAN.md");
  try {
    if (!(await args.fs.exists(path))) return null;
    const content = await args.fs.readTextFile(path);
    return { path, content: truncate(content.trim()) };
  } catch {
    return null;
  }
}

export function buildWorkflowContextPreamble(args: {
  snapshot: WorkflowSnapshot | null;
  userText: string;
  desktopPlan?: { path: string; content: string } | null;
}): string | null {
  if (!args.snapshot) return null;
  const snapshot = args.snapshot;
  const phase = currentPhase(snapshot);
  const parts: string[] = [
    "当前工作流上下文（系统事实，不要忽略）：",
    `- 工作流目标：${snapshot.intent.objective}`,
    `- 当前阶段：${phase}`,
    `- 执行模式：${snapshot.intent.executionMode}`,
  ];

  if (snapshot.context.planSource) {
    const source = snapshot.context.planSource;
    const path = source.kind === "file" ? `，路径：${source.ref}` : "";
    const label = source.label ? `，说明：${source.label}` : "";
    const phase = source.phase ? `，绑定阶段：${source.phase}` : "";
    parts.push(`- 方案来源：${source.kind}，引用：${source.ref}，绑定时间：${source.boundAt}${phase}${path}${label}`);
    if (source.summary && source.summary !== snapshot.context.planSummary) {
      parts.push(`- 方案来源摘要：${source.summary}`);
    }
  }

  if (snapshot.context.planSummary) {
    parts.push(`\n已记录的方案摘要：\n${snapshot.context.planSummary}`);
  }
  if (snapshot.context.reviewSummary) {
    parts.push(`\n已记录的评审摘要：\n${snapshot.context.reviewSummary}`);
  }
  if (snapshot.context.debateSummary) {
    parts.push(`\n已记录的多模型对弈/降级结果：\n${snapshot.context.debateSummary}`);
  }

  if (args.desktopPlan) {
    parts.push(
      `\n已读取到用户桌面的方案文件：${args.desktopPlan.path}`,
      `\n方案文件内容：\n${args.desktopPlan.content}`,
    );
    // 2026-07-10 移植 OMO boulder-state 思路：数方案里的 checkbox 清单，把真实完成进度
    // 注入进来，防止清单还有未勾选项时模型就自称"全部完成"（详见 plan-checklist.ts）。
    const checklistStatus = formatPlanChecklistStatus(parsePlanChecklist(args.desktopPlan.content));
    if (checklistStatus) parts.push(`\n${checklistStatus}`);
  } else if (referencesExistingPlan(args.userText) && /执行|开始|直接|按|照|方案/i.test(args.userText)) {
    parts.push(
      "\n用户正在要求按既定方案执行，但本轮没有读取到完整方案文件。",
      "如果需要依赖具体方案细节，必须先用工具读取明确的方案文件；读不到就说明拿不到，不要凭聊天记忆猜。",
    );
  }

  if (phase === "execute") {
    parts.push(
      "\n执行阶段要求：先对齐方案来源，再改代码；阶段检查只是执行过程的一部分，不要每个阶段都停下来等用户确认。执行完成后继续验证，除非遇到权限、安全、范围或构建测试阻塞。",
    );
  }

  return parts.join("\n");
}
