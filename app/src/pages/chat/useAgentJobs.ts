import { useCallback, useEffect, useRef, useState } from "react";
import { agentJobs, type AgentJobRow } from "@/lib/db/agent-jobs";

/** 轮询间隔：2 秒——够实时感，不至于频繁打 DB。 */
const POLL_INTERVAL_MS = 2000;

/**
 * Agent Job 数据 hook —— 按 workflowRunId 轮询任务列表，提供取消/重试（乐观更新）。
 *
 * 设计要点：
 * - 有活跃任务（running/queued）时才轮询；全部结束则停止轮询，省资源。
 * - 组件卸载时清理定时器，防内存泄漏。
 * - cancel/retry 先改本地状态（乐观更新），再落库；失败时回滚。
 * - workflowRunId 为 null 时不做任何请求（新会话还没 workflow）。
 */
export function useAgentJobs(workflowRunId: string | null) {
  const [jobs, setJobs] = useState<AgentJobRow[]>([]);
  /** 防止竞态：组件卸载后不再 setState。 */
  const mountedRef = useRef(true);

  const fetchJobs = useCallback(async (runId: string) => {
    try {
      const rows = await agentJobs.listByWorkflow(runId);
      if (mountedRef.current) {
        setJobs(rows);
      }
    } catch {
      // DB 错误不崩面板——下次轮询会重试
    }
  }, []);

  // 初始加载 + workflowRunId 变化时重新加载
  useEffect(() => {
    mountedRef.current = true;
    if (!workflowRunId) {
      setJobs([]);
      return;
    }
    void fetchJobs(workflowRunId);

    return () => {
      mountedRef.current = false;
    };
  }, [workflowRunId, fetchJobs]);

  const hasActiveJobs = jobs.some((j) => j.status === "running" || j.status === "queued");

  // 轮询 effect：有活跃任务时每 2s 刷新。
  // 依赖 hasActiveJobs 布尔（而非整个 jobs 数组）——否则每次 2s 轮询 setJobs 都会产生新
  // 数组引用、触发 effect 重跑，导致 interval 被反复销毁重建、耗时抖动。改成只在
  // "有无活跃任务"这个布尔翻转时才重建定时器。
  useEffect(() => {
    if (!workflowRunId || !hasActiveJobs) return;

    const intervalId = setInterval(() => {
      void fetchJobs(workflowRunId);
    }, POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [workflowRunId, hasActiveJobs, fetchJobs]);

  // 取消任务（乐观更新）
  const cancelJob = useCallback(async (jobId: string, reason: string) => {
    // 乐观更新：立刻把本地状态改成 cancelled
    const prev = jobs;
    setJobs((cur) =>
      cur.map((j) =>
        j.id === jobId
          ? { ...j, status: "cancelled" as const, cancellationReason: reason, completedAt: new Date().toISOString() }
          : j,
      ),
    );
    try {
      await agentJobs.cancel(jobId, reason);
      // 落库成功后刷新一次，拿到服务端的最终状态
      if (workflowRunId && mountedRef.current) {
        void fetchJobs(workflowRunId);
      }
    } catch {
      // 落库失败：回滚
      if (mountedRef.current) setJobs(prev);
    }
  }, [jobs, workflowRunId, fetchJobs]);

  // 重试任务（乐观更新）
  const retryJob = useCallback(async (jobId: string) => {
    const prev = jobs;
    setJobs((cur) =>
      cur.map((j) =>
        j.id === jobId
          ? { ...j, status: "running" as const, retryCount: j.retryCount + 1, failureCode: null, cancellationReason: null, completedAt: null, startedAt: new Date().toISOString() }
          : j,
      ),
    );
    try {
      await agentJobs.retry(jobId);
      if (workflowRunId && mountedRef.current) {
        void fetchJobs(workflowRunId);
      }
    } catch {
      if (mountedRef.current) setJobs(prev);
    }
  }, [jobs, workflowRunId, fetchJobs]);

  return { jobs, cancelJob, retryJob };
}
