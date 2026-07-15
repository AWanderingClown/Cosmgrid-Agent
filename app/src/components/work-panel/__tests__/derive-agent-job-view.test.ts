import { describe, expect, it } from "vitest";
import type { AgentJobRow } from "@/lib/db/agent-jobs";
import { deriveAgentJobList, deriveAgentJobView } from "../derive-agent-job-view";

const NOW_MS = new Date("2026-07-15T12:00:00.000Z").getTime();

function makeJob(overrides: Partial<AgentJobRow> = {}): AgentJobRow {
  return {
    id: "job-1",
    parentJobId: null,
    workflowRunId: "run-1",
    role: "leader",
    modelId: "claude-4",
    status: "running",
    objective: "读取项目结构",
    inputContextRefsJson: "[]",
    outputArtifactRefsJson: "[]",
    startedAt: "2026-07-15T11:59:50.000Z", // 10 秒前
    completedAt: null,
    failureCode: null,
    retryCount: 0,
    cancellationReason: null,
    createdAt: "2026-07-15T11:59:50.000Z",
    updatedAt: "2026-07-15T11:59:50.000Z",
    ...overrides,
  };
}

describe("deriveAgentJobView", () => {
  it("running 任务：可取消、不可重试、耗时 = now - startedAt", () => {
    const job = makeJob({ status: "running" });
    const view = deriveAgentJobView(job, NOW_MS);
    expect(view.status).toBe("running");
    expect(view.statusLabel).toBe("运行中");
    expect(view.canCancel).toBe(true);
    expect(view.canRetry).toBe(false);
    expect(view.elapsedMs).toBe(10000); // 10 秒
    expect(view.elapsedLabel).toBe("10s");
  });

  it("queued 任务：可取消、不可重试", () => {
    const job = makeJob({ status: "queued", startedAt: null });
    const view = deriveAgentJobView(job, NOW_MS);
    expect(view.statusLabel).toBe("排队中");
    expect(view.canCancel).toBe(true);
    expect(view.canRetry).toBe(false);
    expect(view.elapsedMs).toBeNull();
    expect(view.elapsedLabel).toBe("-");
  });

  it("succeeded 任务：不可取消、不可重试、耗时 = completedAt - startedAt", () => {
    const job = makeJob({
      status: "succeeded",
      startedAt: "2026-07-15T11:59:00.000Z",
      completedAt: "2026-07-15T11:59:30.000Z",
    });
    const view = deriveAgentJobView(job, NOW_MS);
    expect(view.statusLabel).toBe("完成");
    expect(view.canCancel).toBe(false);
    expect(view.canRetry).toBe(false);
    expect(view.elapsedMs).toBe(30000); // 30 秒
    expect(view.elapsedLabel).toBe("30s");
  });

  it("failed 任务：不可取消、可重试", () => {
    const job = makeJob({
      status: "failed",
      failureCode: "model_error",
      startedAt: "2026-07-15T11:59:00.000Z",
      completedAt: "2026-07-15T11:59:05.000Z",
    });
    const view = deriveAgentJobView(job, NOW_MS);
    expect(view.statusLabel).toBe("失败");
    expect(view.canCancel).toBe(false);
    expect(view.canRetry).toBe(true);
  });

  it("cancelled 任务：不可取消、可重试", () => {
    const job = makeJob({
      status: "cancelled",
      cancellationReason: "用户手动取消",
      startedAt: "2026-07-15T11:59:00.000Z",
      completedAt: "2026-07-15T11:59:03.000Z",
    });
    const view = deriveAgentJobView(job, NOW_MS);
    expect(view.statusLabel).toBe("已取消");
    expect(view.canCancel).toBe(false);
    expect(view.canRetry).toBe(true);
  });

  it("merged 任务：不可取消、不可重试", () => {
    const job = makeJob({
      status: "merged",
      startedAt: "2026-07-15T11:59:00.000Z",
      completedAt: "2026-07-15T11:59:10.000Z",
    });
    const view = deriveAgentJobView(job, NOW_MS);
    expect(view.statusLabel).toBe("已合并");
    expect(view.canCancel).toBe(false);
    expect(view.canRetry).toBe(false);
  });

  it("耗时超过 60 秒格式化为 'Xm Ys'", () => {
    const job = makeJob({
      status: "succeeded",
      startedAt: "2026-07-15T11:57:30.000Z",
      completedAt: "2026-07-15T11:59:05.000Z", // 1 分 35 秒
    });
    const view = deriveAgentJobView(job, NOW_MS);
    expect(view.elapsedLabel).toBe("1m 35s");
  });

  it("retryCount 透传到视图", () => {
    const job = makeJob({ status: "failed", retryCount: 2 });
    const view = deriveAgentJobView(job, NOW_MS);
    expect(view.retryCount).toBe(2);
  });
});

describe("deriveAgentJobList", () => {
  it("空列表 → hasJobs=false, activeCount=0", () => {
    const view = deriveAgentJobList([], NOW_MS);
    expect(view.hasJobs).toBe(false);
    expect(view.activeCount).toBe(0);
    expect(view.jobs).toEqual([]);
  });

  it("混合状态列表 → activeCount 只算 running+queued", () => {
    const jobs = [
      makeJob({ id: "j1", status: "running" }),
      makeJob({ id: "j2", status: "queued", startedAt: null }),
      makeJob({ id: "j3", status: "succeeded", completedAt: "2026-07-15T11:59:55.000Z" }),
      makeJob({ id: "j4", status: "failed", completedAt: "2026-07-15T11:59:55.000Z" }),
    ];
    const view = deriveAgentJobList(jobs, NOW_MS);
    expect(view.hasJobs).toBe(true);
    expect(view.activeCount).toBe(2); // running + queued
    expect(view.jobs).toHaveLength(4);
  });

  it("全部已结束 → activeCount=0", () => {
    const jobs = [
      makeJob({ id: "j1", status: "succeeded", completedAt: "2026-07-15T11:59:55.000Z" }),
      makeJob({ id: "j2", status: "cancelled", completedAt: "2026-07-15T11:59:55.000Z" }),
    ];
    const view = deriveAgentJobList(jobs, NOW_MS);
    expect(view.activeCount).toBe(0);
  });
});
