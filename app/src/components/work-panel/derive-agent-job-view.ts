// Agent Job 面板派生函数 —— 把 AgentJobRow[] 转成视图模型。
//
// 纯逻辑、无副作用，方便单测。组件层只负责渲染 + 调 hook 拿数据。
// 视觉规范沿用 EvidencePanel / WorkflowDiagnostics 的"9px uppercase tracking-[0.2em]"
// + statusClass() 配色 + <details className="group"> 折叠。

import type { AgentJobRow } from "@/lib/db/agent-jobs";
import type { AgentJobStatus } from "@/lib/llm/agent-jobs/types";

export interface AgentJobView {
  id: string;
  role: string;
  status: AgentJobStatus;
  /** 人类可读状态文案（运行中 / 完成 / 失败 / 已取消 / 已合并 / 排队中）。 */
  statusLabel: string;
  /** 状态徽章的 tailwind 配色类。 */
  statusAccent: string;
  objective: string;
  /** 耗时（毫秒），running 时 = now - startedAt，已结束时 = completedAt - startedAt。 */
  elapsedMs: number | null;
  /** 耗时人类可读文案（"12s" / "1m 30s" / "-"）。 */
  elapsedLabel: string;
  /** running/queued 时可取消。 */
  canCancel: boolean;
  /** failed/cancelled 时可重试。 */
  canRetry: boolean;
  retryCount: number;
}

export interface AgentJobListView {
  hasJobs: boolean;
  /** running + queued 的数量，用于面板标题摘要。 */
  activeCount: number;
  jobs: AgentJobView[];
}

const STATUS_LABEL: Record<AgentJobStatus, string> = {
  queued: "排队中",
  running: "运行中",
  succeeded: "完成",
  failed: "失败",
  cancelled: "已取消",
  merged: "已合并",
};

const STATUS_ACCENT: Record<AgentJobStatus, string> = {
  queued: "bg-amber-400/12 text-amber-300 border-amber-400/15",
  running: "bg-blue-400/12 text-blue-300 border-blue-400/15",
  succeeded: "bg-emerald-400/12 text-emerald-300 border-emerald-400/15",
  failed: "bg-rose-400/12 text-rose-300 border-rose-400/15",
  cancelled: "bg-white/5 text-muted-foreground border-white/5",
  merged: "bg-emerald-400/12 text-emerald-300 border-emerald-400/15",
};

function formatElapsedMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
}

/**
 * 把单条 AgentJobRow 派生成视图模型。
 * @param job 数据库行
 * @param nowMs 当前时间戳（毫秒），用于计算 running 任务的耗时
 */
export function deriveAgentJobView(job: AgentJobRow, nowMs: number): AgentJobView {
  const status = job.status;

  // 耗时计算：running/queued → now - startedAt；已结束 → completedAt - startedAt
  let elapsedMs: number | null = null;
  if (job.startedAt) {
    const start = new Date(job.startedAt).getTime();
    if (status === "running" || status === "queued") {
      elapsedMs = Math.max(0, nowMs - start);
    } else if (job.completedAt) {
      elapsedMs = new Date(job.completedAt).getTime() - start;
    }
  }

  return {
    id: job.id,
    role: job.role,
    status,
    statusLabel: STATUS_LABEL[status],
    statusAccent: STATUS_ACCENT[status],
    objective: job.objective,
    elapsedMs,
    elapsedLabel: elapsedMs !== null ? formatElapsedMs(elapsedMs) : "-",
    canCancel: status === "running" || status === "queued",
    canRetry: status === "failed" || status === "cancelled",
    retryCount: job.retryCount,
  };
}

/**
 * 把 AgentJobRow[] 派生成列表视图模型。
 * @param jobs 数据库行数组（通常来自 agentJobs.listByWorkflow）
 * @param nowMs 当前时间戳（毫秒）
 */
export function deriveAgentJobList(jobs: AgentJobRow[], nowMs: number): AgentJobListView {
  const views = jobs.map((job) => deriveAgentJobView(job, nowMs));
  return {
    hasJobs: views.length > 0,
    activeCount: views.filter((v) => v.canCancel).length,
    jobs: views,
  };
}
