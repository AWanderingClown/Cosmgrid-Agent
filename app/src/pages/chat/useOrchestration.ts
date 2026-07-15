import { useCallback, useReducer, useRef } from "react";
import {
  type OrchestrationState,
  type RoleId,
} from "@/lib/llm/orchestrator";
import { applyNextActionChoice } from "@/lib/workflow/reducer";
import type { WorkflowSnapshot } from "@/lib/workflow/types";
import { workflowRuns, type WorkflowEvent } from "@/lib/db";

interface OrchState {
  orchestration: OrchestrationState | null;
  chainExecutedRoles: RoleId[];
  chainSkippedRoles: RoleId[];
  chainAbortedRole: RoleId | null;
  chainRunning: boolean;
  workflowSnapshot: WorkflowSnapshot | null;
  workflowEvents: WorkflowEvent[];
}

const initialOrchState: OrchState = {
  orchestration: null,
  chainExecutedRoles: [],
  chainSkippedRoles: [],
  chainAbortedRole: null,
  chainRunning: false,
  workflowSnapshot: null,
  workflowEvents: [],
};

type OrchAction =
  | { type: "apply_orchestration"; state: OrchestrationState | null }
  | { type: "chain_start" }
  | { type: "chain_role_done"; role: RoleId }
  | { type: "chain_role_skipped"; role: RoleId }
  | { type: "chain_abort"; role: RoleId }
  | { type: "chain_end" }
  | { type: "apply_workflow"; snapshot: WorkflowSnapshot | null }
  | { type: "apply_workflow_events"; events: WorkflowEvent[] }
  | { type: "set_chain_executed_roles"; updater: (prev: RoleId[]) => RoleId[] }
  | { type: "set_chain_skipped_roles"; updater: (prev: RoleId[]) => RoleId[] }
  | { type: "set_chain_aborted_role"; role: RoleId | null }
  | { type: "set_chain_running"; running: boolean }
  | { type: "reset" };

function reducer(state: OrchState, action: OrchAction): OrchState {
  switch (action.type) {
    case "apply_orchestration":
      return { ...state, orchestration: action.state };
    case "chain_start":
      return {
        ...state,
        chainRunning: true,
        chainExecutedRoles: [],
        chainSkippedRoles: [],
        chainAbortedRole: null,
      };
    case "chain_role_done":
      return {
        ...state,
        chainExecutedRoles: [...state.chainExecutedRoles, action.role],
      };
    case "chain_role_skipped":
      return {
        ...state,
        chainSkippedRoles: [...state.chainSkippedRoles, action.role],
      };
    case "chain_abort":
      return {
        ...state,
        chainAbortedRole: action.role,
        chainRunning: false,
      };
    case "chain_end":
      return {
        ...state,
        chainRunning: false,
      };
    case "apply_workflow":
      return { ...state, workflowSnapshot: action.snapshot };
    case "apply_workflow_events":
      return { ...state, workflowEvents: action.events };
    case "set_chain_executed_roles":
      return { ...state, chainExecutedRoles: action.updater(state.chainExecutedRoles) };
    case "set_chain_skipped_roles":
      return { ...state, chainSkippedRoles: action.updater(state.chainSkippedRoles) };
    case "set_chain_aborted_role":
      return { ...state, chainAbortedRole: action.role };
    case "set_chain_running":
      return { ...state, chainRunning: action.running };
    case "reset":
      return initialOrchState;
    default:
      return state;
  }
}

export interface UseOrchestrationOptions {
  // 当前未使用——hook D 内部状态自管理；保留以备阶段 7 hook C 触发 reset 时按 conversationId 区分
  conversationId?: string | null;
}

/** hook D：编排 + 对弈链 + 工作流快照。
 *  持 6 state（orchestration/chainExecutedRoles/chainSkippedRoles/chainAbortedRole/
 *  chainRunning/workflowSnapshot）+ 3 ref（orchestrationRef/workflowSnapshotRef/
 *  chainAbortRef），用 useReducer 重构为天然状态机。
 *  提供 applyOrchestration / applyWorkflowSnapshot（同步更新 ref + dispatch，
 *  保持 handleSend 同步读 ref 的行为）+ loadWorkflowForConversation。 */
export function useOrchestration(_opts: UseOrchestrationOptions = {}) {
  const [state, dispatch] = useReducer(reducer, initialOrchState);
  const orchestrationRef = useRef<OrchestrationState | null>(state.orchestration);
  const workflowSnapshotRef = useRef<WorkflowSnapshot | null>(state.workflowSnapshot);
  const chainAbortRef = useRef<AbortController | null>(null);

  function applyOrchestration(next: OrchestrationState | null): void {
    orchestrationRef.current = next;
    dispatch({ type: "apply_orchestration", state: next });
  }

  function applyWorkflowSnapshot(next: WorkflowSnapshot | null): void {
    workflowSnapshotRef.current = next;
    dispatch({ type: "apply_workflow", snapshot: next });
  }

  function applyWorkflowEvents(events: WorkflowEvent[]): void {
    dispatch({ type: "apply_workflow_events", events });
  }

  // 兼容 setState 接口（handleSend 内部用 functional update 模式）
  function setChainExecutedRoles(updater: RoleId[] | ((prev: RoleId[]) => RoleId[])): void {
    const fn = typeof updater === "function" ? updater : () => updater;
    dispatch({ type: "set_chain_executed_roles", updater: fn });
  }
  function setChainSkippedRoles(updater: RoleId[] | ((prev: RoleId[]) => RoleId[])): void {
    const fn = typeof updater === "function" ? updater : () => updater;
    dispatch({ type: "set_chain_skipped_roles", updater: fn });
  }
  function setChainAbortedRole(role: RoleId | null): void {
    dispatch({ type: "set_chain_aborted_role", role });
  }
  function setChainRunning(running: boolean): void {
    dispatch({ type: "set_chain_running", running });
  }

  /**
   * Task #9（2026-07-15）：用户在 NextActionsCard 上点了某个 nextAction 按钮——直接用
   * reducer 的 applyNextActionChoice 确定性推进（不经过 intent classifier），同步更新
   * UI 快照 + 落库（跟 prepare-turn-workflow.ts 里 intent classifier 推进后的落库方式一致，
   * eventType 用 "workflow.intent_applied"，payload 标 source: "user_click" 方便跟分类器
   * 推进的事件区分）。actionId 找不到（按钮已经陈旧）时 applyNextActionChoice 原样返回
   * 快照，这里用引用相等判断"没有变化"，不做任何 UI/落库操作。
   */
  const pickNextAction = useCallback(async (actionId: string): Promise<void> => {
    const current = workflowSnapshotRef.current;
    if (!current) return;
    const next = applyNextActionChoice({ snapshot: current, actionId });
    if (next === current) return;
    applyWorkflowSnapshot(next);
    try {
      await workflowRuns.saveSnapshot({
        runId: next.runId,
        snapshot: next,
        eventType: "workflow.intent_applied",
        eventPayload: { source: "user_click", actionId },
      });
    } catch {
      // 落库失败不影响当前会话内已经生效的 UI 状态；跟其余 workflow 落库失败处理方式一致
      // （prepare-turn-workflow.ts 的 saveSnapshot 调用也是尽力而为，不阻塞用户继续操作）。
    }
  }, []);

  const loadWorkflowForConversation = useCallback(async (id: string) => {
    try {
      const activeRun = await workflowRuns.getActiveByConversation(id);
      applyWorkflowSnapshot(activeRun?.snapshot ?? null);
      if (activeRun) {
        applyWorkflowEvents(await workflowRuns.listEvents(activeRun.id));
      } else {
        applyWorkflowEvents([]);
      }
    } catch {
      applyWorkflowSnapshot(null);
      applyWorkflowEvents([]);
    }
  }, []);

  return {
    // state
    chainAbortedRole: state.chainAbortedRole,
    chainExecutedRoles: state.chainExecutedRoles,
    chainRunning: state.chainRunning,
    chainSkippedRoles: state.chainSkippedRoles,
    orchestration: state.orchestration,
    workflowEvents: state.workflowEvents,
    workflowSnapshot: state.workflowSnapshot,
    // setter（兼容 handleSend 内部的 setState 模式）
    setChainAbortedRole,
    setChainExecutedRoles,
    setChainRunning,
    setChainSkippedRoles,
    // ref
    chainAbortRef,
    orchestrationRef,
    workflowSnapshotRef,
    // 协调函数（ref 同步 + dispatch）
    applyOrchestration,
    applyWorkflowEvents,
    applyWorkflowSnapshot,
    // Task #9：用户点了 NextActionsCard 按钮时调用
    pickNextAction,
    // load
    loadWorkflowForConversation,
  };
}

export type UseOrchestrationReturn = ReturnType<typeof useOrchestration>;
