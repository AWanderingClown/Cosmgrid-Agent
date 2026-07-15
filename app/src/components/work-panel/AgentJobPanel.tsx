// Agent Job 面板 —— 显示当前 workflow 的后台任务状态，支持取消/重试。
//
// 服务产品真北：让用户看得见 AI 在后台并行做了什么（比如对弈时的多角色调用），
// 能取消、能重试。后端 agentJobs DAO 已齐全，这里补前端。
//
// 视觉规范沿用 EvidencePanel / WorkflowDiagnostics 的"9px uppercase tracking-[0.2em]"
// + <details className="group"> 折叠。面板保持轻量——没有 job 时不渲染。

import { useTranslation } from "react-i18next";
import { Loader2, RotateCcw, Square, Workflow } from "lucide-react";
import { deriveAgentJobList } from "./derive-agent-job-view";
import { useAgentJobs } from "@/pages/chat/useAgentJobs";

interface Props {
  /** 当前 workflow 运行 ID，null 时面板不渲染。 */
  workflowRunId: string | null;
}

export function AgentJobPanel({ workflowRunId }: Props) {
  const { t } = useTranslation();
  const { jobs, cancelJob, retryJob } = useAgentJobs(workflowRunId);

  const view = deriveAgentJobList(jobs, Date.now());

  // 没有 job 时不渲染——保持右侧面板轻量
  if (!view.hasJobs) return null;

  return (
    <details className="group rounded-lg border border-border/60 bg-foreground/[0.03]" open={view.activeCount > 0}>
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground/80">
        <Workflow className="h-3.5 w-3.5" />
        <span>{t("chat.workPanel.agentJobs.title", "后台任务")}</span>
        {view.activeCount > 0 && (
          <span className="flex items-center gap-1 text-[10px] uppercase tracking-[0.18em] text-blue-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            {view.activeCount}
          </span>
        )}
      </summary>
      <div className="space-y-1.5 border-t border-border/60 px-3 py-2">
        {view.jobs.map((job) => (
          <div
            key={job.id}
            className="flex items-center gap-2 rounded-md border border-border/40 bg-foreground/[0.02] px-2 py-1.5"
          >
            {/* 状态徽章 */}
            <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-medium ${job.statusAccent}`}>
              {job.statusLabel}
            </span>
            {/* 角色 */}
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">{job.role}</span>
            {/* 目标（截断） */}
            <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/80">{job.objective}</span>
            {/* 耗时 */}
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/50">{job.elapsedLabel}</span>
            {/* 重试标记 */}
            {job.retryCount > 0 && (
              <span className="shrink-0 text-[9px] text-muted-foreground/40">×{job.retryCount}</span>
            )}
            {/* 取消按钮 */}
            {job.canCancel && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void cancelJob(job.id, "用户手动取消");
                }}
                className="shrink-0 rounded p-1 text-muted-foreground/50 hover:bg-rose-500/10 hover:text-rose-400"
                title={t("chat.workPanel.agentJobs.cancel", "取消")}
              >
                <Square className="h-3 w-3" />
              </button>
            )}
            {/* 重试按钮 */}
            {job.canRetry && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void retryJob(job.id);
                }}
                className="shrink-0 rounded p-1 text-muted-foreground/50 hover:bg-blue-500/10 hover:text-blue-400"
                title={t("chat.workPanel.agentJobs.retry", "重试")}
              >
                <RotateCcw className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
