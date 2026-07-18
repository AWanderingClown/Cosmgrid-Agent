// 阶段5 Playbook — WorkPanel 记忆面板（2026-07-17 断点④接线，同日补 Curator 确认 UI，
// 同日二轮复检修完 1 HIGH + 3 MEDIUM）。
//
// 三个区块（都无内容时整个面板不渲染，保持轻量）：
// 1. 待确认候选（status='candidate'，pipeline requiresConfirm 落进来的，不含冲突配对项）：
//    ✓ 转正 markActive（进 active 池开始注入 prompt）/ ✗ 拒绝 markArchived（降权不删）
// 2. 冲突待裁决（status='disputed'，curator 检测到内容矛盾标记的老条目）：
//    - 有配对新 candidate（candidate.supersedesId === disputed.id，可能不止一条——同一批事件
//      可以产生多条各自都跟同一老条目冲突的 candidate）时成组展示：
//      · 点老条目 ✓「保留旧事实」→ 老条目转正 + 全部配对 candidate 归档
//      · 点某个 candidate ✓「改用新事实」→ 该 candidate 转正 + 老条目归档（其余 sibling
//        candidate 不受影响，老条目一旦离开 disputed 状态，它们下一次渲染就自然落进
//        "待确认候选"区单独裁决——不需要额外写库联动）
//      任一方点 ✗ 只归档自己，不牵连对方/sibling。
//      绝不允许互相矛盾的两条同时 active（2026-07-17 复检 HIGH：原来两边各自独立确认，
//      用户可能都点保留，导致矛盾事实同时进 prompt）。
//    - 无配对（老流程遗留数据）时按普通条目单独裁决：✓ 保留 markActive / ✗ 归档 markArchived
// 3. 本轮注入（props.memories）：👍 recordMemoryHelpful / 👎 recordMemoryHarmful
//
// 数据刷新：projectId 变化 / refreshTick 变化（pipeline 后台跑完主动通知，见 stream-finalization
// 的 onPlaybookMemoryChange）时 refetch。刷新结果会过滤掉当前正在写库途中的条目 id
// （pendingIdsRef，2026-07-17 二轮复检 MEDIUM 修复）——否则用户刚裁决完、写库还没落地时
// 恰好一次 refetch 命中，会把已经乐观移除的条目从 DB 读出的旧状态里重新塞回来，且之后
// 再也没有机会纠正（写库成功后 DB 状态变了不会再被读出来；写库失败会被下面的回滚逻辑
// 处理，但如果先被 refetch 复活、后面才回滚，会短暂出现"看起来像是决策生效了又消失"的抖动）。
//
// 每次写库都是独立的 fire-and-forget（不用 Promise.all 打包）：转正和归档各自失败各自回滚，
// 不会出现"归档失败导致已经成功转正的条目也被 UI 打回未决定状态"这种 DB/UI 状态错位
// （2026-07-17 二轮复检 MEDIUM 修复：原来用 Promise.all，一个失败两个都回滚）。

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Archive, BookOpenCheck, Check, ThumbsDown, ThumbsUp } from "lucide-react";
import { projectMemories, type ProjectMemory } from "@/lib/db/memory";
import { recordMemoryHelpful, recordMemoryHarmful } from "@/lib/llm/playbook/feedback";
import { excludePendingIds, groupPlaybookCandidates } from "./derive-playbook-groups";

interface PlaybookPanelProps {
  /** 本轮注入 prompt 的记忆条目（赞踩反馈列表） */
  memories: ProjectMemory[];
  /** 当前项目 id（候选/裁决区数据源；null = 无项目绑定，只渲染本轮注入区） */
  projectId?: string | null;
  /** pipeline 后台跑完的计数信号；变化时 refetch（不承载业务含义，纯触发器） */
  refreshTick?: number;
}

/** 单条记录行的操作按钮组 */
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

/** 把条目从列表移除（乐观更新用） */
function removeFromList(
  setList: React.Dispatch<React.SetStateAction<ProjectMemory[]>>,
  id: string,
) {
  setList((prev) => prev.filter((m) => m.id !== id));
}

/** 写库失败回滚：条目放回列表（按 id 去重，避免和并发 refetch 重复插入） */
function restoreToList(
  setList: React.Dispatch<React.SetStateAction<ProjectMemory[]>>,
  memory: ProjectMemory,
) {
  setList((prev) => (prev.some((m) => m.id === memory.id) ? prev : [memory, ...prev]));
}

export function PlaybookPanel({ memories, projectId = null, refreshTick = 0 }: PlaybookPanelProps) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState<Record<string, "helpful" | "harmful">>({});
  const [candidates, setCandidates] = useState<ProjectMemory[]>([]);
  const [disputed, setDisputed] = useState<ProjectMemory[]>([]);
  // 正在写库途中的条目 id：refetch 结果要排除它们，防止半路把刚裁决的条目复活
  const pendingIdsRef = useRef<Set<string>>(new Set());

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
        const pending = pendingIdsRef.current;
        setCandidates(excludePendingIds(cand, pending));
        setDisputed(excludePendingIds(disp, pending));
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
  }, [projectId, refreshTick]);

  if (memories.length === 0 && candidates.length === 0 && disputed.length === 0) return null;

  function handleFeedback(memoryId: string, kind: "helpful" | "harmful") {
    if (feedback[memoryId]) return;
    setFeedback((prev) => ({ ...prev, [memoryId]: kind }));
    void (kind === "helpful" ? recordMemoryHelpful(memoryId) : recordMemoryHarmful(memoryId));
  }

  /** 单条写库：转正/归档独立执行，失败只回滚这一条，成功/失败都清 pending 标记 */
  function writeDecision(
    memory: ProjectMemory,
    decision: "approve" | "reject",
    setList: React.Dispatch<React.SetStateAction<ProjectMemory[]>>,
  ) {
    pendingIdsRef.current.add(memory.id);
    void (decision === "approve"
      ? projectMemories.markActive(memory.id)
      : projectMemories.markArchived(memory.id)
    )
      .catch((err) => {
        console.error("[playbook] curator 决策写库失败：", err instanceof Error ? err.message : String(err));
        restoreToList(setList, memory);
      })
      .finally(() => pendingIdsRef.current.delete(memory.id));
  }

  /** 独立条目（无冲突配对）的转正/归档 */
  function handleSoloDecision(
    memory: ProjectMemory,
    decision: "approve" | "reject",
    setList: React.Dispatch<React.SetStateAction<ProjectMemory[]>>,
  ) {
    removeFromList(setList, memory.id);
    writeDecision(memory, decision, setList);
  }

  /** 只归档自己，不牵连配对的另一方/sibling（对方仍留在各自列表等用户单独裁决） */
  function handleRejectOnly(
    memory: ProjectMemory,
    setList: React.Dispatch<React.SetStateAction<ProjectMemory[]>>,
  ) {
    removeFromList(setList, memory.id);
    writeDecision(memory, "reject", setList);
  }

  /**
   * 冲突配对互斥裁决：winner 转正，loser(s) 强制归档——绝不允许老条目和它的矛盾替代品
   * 同时 active。两个方向的写库各自独立（writeDecision 各管各的回滚），不会因为一个
   * 失败牵连另一个已经成功的操作。
   */
  function handleLinkedDecision(
    disputedItem: ProjectMemory,
    linkedCandidates: ProjectMemory[],
    winner: ProjectMemory | "disputed",
  ) {
    const keepOld = winner === "disputed";
    if (keepOld) {
      // 保留老条目：老条目转正，全部配对 candidate 归档
      removeFromList(setDisputed, disputedItem.id);
      setCandidates((prev) => prev.filter((c) => !linkedCandidates.some((lc) => lc.id === c.id)));
      writeDecision(disputedItem, "approve", setDisputed);
      for (const lc of linkedCandidates) writeDecision(lc, "reject", setCandidates);
    } else {
      // 改用某个具体 candidate：该 candidate 转正，老条目归档；其余 sibling candidate
      // 不动——老条目从 disputed 列表消失后，它们下一次渲染会自然落进"待确认候选"区
      removeFromList(setDisputed, disputedItem.id);
      removeFromList(setCandidates, winner.id);
      writeDecision(winner, "approve", setCandidates);
      writeDecision(disputedItem, "reject", setDisputed);
    }
  }

  const { groups: disputeGroups, plainCandidates } = groupPlaybookCandidates(disputed, candidates);

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
        {disputed.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50">
              {t("chat.workPanel.playbook.disputedTitle", { count: disputed.length })}
            </div>
            {disputeGroups.map(({ disputed: d, linkedCandidates: linked }) => {
              if (linked.length === 0) {
                // 无配对（老数据/边界情况）：按普通条目单独裁决
                return (
                  <MemoryRow
                    key={d.id}
                    memory={d}
                    right={
                      <DecisionButtons
                        approveTitle={t("chat.workPanel.playbook.keep")}
                        rejectTitle={t("chat.workPanel.playbook.archive")}
                        onApprove={() => handleSoloDecision(d, "approve", setDisputed)}
                        onReject={() => handleRejectOnly(d, setDisputed)}
                      />
                    }
                  />
                );
              }
              return (
                <div key={d.id} className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-1.5 space-y-1">
                  <div className="px-1.5 text-[9px] font-black uppercase tracking-wider text-amber-400/80">
                    {t("chat.workPanel.playbook.conflictPair")}
                  </div>
                  <MemoryRow
                    memory={d}
                    right={
                      <DecisionButtons
                        approveTitle={t("chat.workPanel.playbook.keepOld")}
                        rejectTitle={t("chat.workPanel.playbook.archive")}
                        onApprove={() => handleLinkedDecision(d, linked, "disputed")}
                        onReject={() => handleRejectOnly(d, setDisputed)}
                      />
                    }
                  />
                  {linked.map((c) => (
                    <MemoryRow
                      key={c.id}
                      memory={c}
                      right={
                        <DecisionButtons
                          approveTitle={t("chat.workPanel.playbook.useNew")}
                          rejectTitle={t("chat.workPanel.playbook.reject")}
                          onApprove={() => handleLinkedDecision(d, linked, c)}
                          onReject={() => handleRejectOnly(c, setCandidates)}
                        />
                      }
                    />
                  ))}
                </div>
              );
            })}
          </div>
        )}
        {plainCandidates.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50">
              {t("chat.workPanel.playbook.candidatesTitle", { count: plainCandidates.length })}
            </div>
            {plainCandidates.map((m) => (
              <MemoryRow
                key={m.id}
                memory={m}
                right={
                  <DecisionButtons
                    approveTitle={t("chat.workPanel.playbook.approve")}
                    rejectTitle={t("chat.workPanel.playbook.reject")}
                    onApprove={() => handleSoloDecision(m, "approve", setCandidates)}
                    onReject={() => handleSoloDecision(m, "reject", setCandidates)}
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
