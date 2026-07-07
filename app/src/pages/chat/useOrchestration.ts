import { useCallback, useReducer, useRef } from "react";
import {
  type OrchestrationState,
  type RoleId,
} from "@/lib/llm/orchestrator";
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
    // load
    loadWorkflowForConversation,
  };
}

export type UseOrchestrationReturn = ReturnType<typeof useOrchestration>;
