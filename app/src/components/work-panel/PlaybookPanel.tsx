// 阶段5 Playbook — WorkPanel 记忆面板（2026-07-17 断点④接线，同日补 Curator 确认 UI）。
//
// 三个区块（都无内容时整个面板不渲染，保持轻量）：
// 1. 待确认候选（status='candidate'，pipeline requiresConfirm 落进来的）：
//    ✓ 转正 markActive（进 active 池开始注入 prompt）/ ✗ 拒绝 markArchived（降权不删）
// 2. 冲突待裁决（status='disputed'，curator 检测到内容矛盾标记的老条目）：
//    ✓ 保留 markActive / ✗ 归档 markArchived
// 3. 本轮注入（props.memories）：👍 recordMemoryHelpful / 👎 recordMemoryHarmful
//
// 数据刷新：projectId 变化 / props.memories 变化（新一轮对话结束，pipeline 可能产生新候选）
// 时 refetch；操作后乐观移除本地条目。查询失败静默空列表（playbook 是观测面）。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Archive, BookOpenCheck, Check, ThumbsDown, ThumbsUp } from "lucide-react";
import { projectMemories, type ProjectMemory } from "@/lib/db/memory";
import { recordMemoryHelpful, recordMemoryHarmful } from "@/lib/llm/playbook/feedback";

interface PlaybookPanelProps {
  /** 本轮注入 prompt 的记忆条目（赞踩反馈列表） */
  memories: ProjectMemory[];
  /** 当前项目 id（候选/裁决区数据源；null = 无项目绑定，只渲染本轮注入区） */
  projectId?: string | null;
}

/** 单条记录行的操作按钮组（转正/保留 = markActive，拒绝/归档 = markArchived） */
function DecisionButtons(props: {
  approveTitle: string;
  rejectTitle: string;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={props.onApprove}
        title={props.approveTitle}
        className="rounded-md p-1 text-muted-foreground/60 hover:bg-white/10 hover:text-emerald-400"
      >
        <Check className="w-3 h-3" />
      </button>
      <button
        type="button"
        onClick={props.onReject}
        title={props.rejectTitle}
        className="rounded-md p-1 text-muted-foreground/60 hover:bg-white/10 hover:text-red-400"
      >
        <Archive className="w-3 h-3" />
      </button>
    </span>
  );
}

function MemoryRow({ memory, right }: { memory: ProjectMemory; right: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-2">
      <span className="shrink-0 rounded-md bg-white/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
        {memory.kind}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/80" title={memory.content}>
        {memory.title}
      </span>
      {right}
    </div>
  );
}

export function PlaybookPanel({ memories, projectId = null }: PlaybookPanelProps) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState<Record<string, "helpful" | "harmful">>({});
  const [candidates, setCandidates] = useState<ProjectMemory[]>([]);
  const [disputed, setDisputed] = useState<ProjectMemory[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!projectId) {
      setCandidates([]);
      setDisputed([]);
      return;
    }
    void (async () => {
      try {
        const [cand, disp] = await Promise.all([
          projectMemories.listByProjectAndStatus(projectId, "candidate"),
          projectMemories.listByProjectAndStatus(projectId, "disputed"),
        ]);
        if (cancelled) return;
        setCandidates(cand);
        setDisputed(disp);
      } catch {
        // playbook 是观测面：查询失败静默空列表，不打扰主流程
        if (cancelled) return;
        setCandidates([]);
        setDisputed([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // memories 变化 = 新一轮对话结束，pipeline 可能刚产生新候选 → 一并 refetch
  }, [projectId, memories]);

  if (memories.length === 0 && candidates.length === 0 && disputed.length === 0) return null;

  function handleFeedback(memoryId: string, kind: "helpful" | "harmful") {
    if (feedback[memoryId]) return;
    setFeedback((prev) => ({ ...prev, [memoryId]: kind }));
    void (kind === "helpful" ? recordMemoryHelpful(memoryId) : recordMemoryHarmful(memoryId));
  }

  function handleDecision(
    memory: ProjectMemory,
    decision: "approve" | "reject",
    setList: React.Dispatch<React.SetStateAction<ProjectMemory[]>>,
  ) {
    // 乐观移除；写库旁路失败只 console（下次 refetch 会回来，不会丢数据）
    setList((prev) => prev.filter((m) => m.id !== memory.id));
    void (decision === "approve"
      ? projectMemories.markActive(memory.id)
      : projectMemories.markArchived(memory.id)
    ).catch((err) => {
      console.error("[playbook] curator 决策写库失败：", err instanceof Error ? err.message : String(err));
    });
  }

  return (
    <details className="group glass rounded-2xl border border-white/5" open={candidates.length > 0 || disputed.length > 0}>
      <summary className="cursor-pointer list-none px-4 py-3 flex items-center gap-2 text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50 hover:text-foreground">
        <BookOpenCheck className="w-3 h-3" />
        {t("chat.workPanel.playbook.title")}
        {(candidates.length > 0 || disputed.length > 0) && (
          <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-bold text-amber-400">
            {candidates.length + disputed.length}
          </span>
        )}
      </summary>
      <div className="px-4 pb-3 space-y-2.5">
        {candidates.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50">
              {t("chat.workPanel.playbook.candidatesTitle", { count: candidates.length })}
            </div>
            {candidates.map((m) => (
              <MemoryRow
                key={m.id}
                memory={m}
                right={
                  <DecisionButtons
                    approveTitle={t("chat.workPanel.playbook.approve")}
                    rejectTitle={t("chat.workPanel.playbook.reject")}
                    onApprove={() => handleDecision(m, "approve", setCandidates)}
                    onReject={() => handleDecision(m, "reject", setCandidates)}
                  />
                }
              />
            ))}
          </div>
        )}
        {disputed.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50">
              {t("chat.workPanel.playbook.disputedTitle", { count: disputed.length })}
            </div>
            {disputed.map((m) => (
              <MemoryRow
                key={m.id}
                memory={m}
                right={
                  <DecisionButtons
                    approveTitle={t("chat.workPanel.playbook.keep")}
                    rejectTitle={t("chat.workPanel.playbook.archive")}
                    onApprove={() => handleDecision(m, "approve", setDisputed)}
                    onReject={() => handleDecision(m, "reject", setDisputed)}
                  />
                }
              />
            ))}
          </div>
        )}
        {memories.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50">
              {t("chat.workPanel.playbook.usedTitle", { count: memories.length })}
            </div>
            {memories.map((m) => {
              const given = feedback[m.id];
              return (
                <MemoryRow
                  key={m.id}
                  memory={m}
                  right={
                    given ? (
                      <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/60">
                        {t("chat.workPanel.playbook.feedbackDone")}
                      </span>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleFeedback(m.id, "helpful")}
                          title={t("chat.workPanel.playbook.helpful")}
                          className="rounded-md p-1 text-muted-foreground/60 hover:bg-white/10 hover:text-emerald-400"
                        >
                          <ThumbsUp className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleFeedback(m.id, "harmful")}
                          title={t("chat.workPanel.playbook.harmful")}
                          className="rounded-md p-1 text-muted-foreground/60 hover:bg-white/10 hover:text-red-400"
                        >
                          <ThumbsDown className="w-3 h-3" />
                        </button>
                      </span>
                    )
                  }
                />
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}
