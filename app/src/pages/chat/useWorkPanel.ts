import { useCallback, useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { conversations as dbConversations } from "@/lib/db";
import { type ToolConfirmRequest } from "@/lib/llm/tools";
import { deriveArtifacts, type WorkArtifact } from "@/lib/work-artifacts";
import { deriveToolCallViews, type ToolCallView } from "@/lib/work-artifact-views";
import type { ToolExecutionRow } from "@/lib/db";

export interface UseWorkPanelOptions {
  conversationId: string | null;
  /** 改会话工作文件夹时同步 conversationList + 写库（ChatPage 协调层实现） */
  onConversationWorkspaceChanged: (path: string | null) => void;
  /** chooseWorkspace / clearWorkspace 守卫：流式回复中禁止改工作文件夹 */
  isStreaming: boolean;
  t: TFunction;
}

/** hook E：右侧工作面板（工作文件夹 + 工具权限档 + 工件 + 工具确认流）。
 *  持 panelOpen / workspacePath / protectedWorkspaces / artifacts / toolCallViews /
 *  pendingConfirm + confirmResolverRef。
 *  提供 applyToolExecutionRows / clearToolExecutionViews / requestConfirm / resolveConfirm /
 *  bindWorkspace / chooseWorkspace / clearWorkspace。
 *  跨 hook 写入走回调（onConversationWorkspaceChanged），守卫依赖 isStreaming。 */
export function useWorkPanel({
  conversationId,
  onConversationWorkspaceChanged,
  isStreaming,
  t,
}: UseWorkPanelOptions) {
  // 右侧工作面板默认收起（内容偏重；实时动作已内联在对话流，不靠右侧展示）
  const [panelOpen, setPanelOpen] = useState(false);

  // 工作文件夹 + 工具权限档（产品真北：让主对话能在本地真干活，不只是聊天）
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);

  // 2.1 步骤2/3 修复（2026-07-02，代码审查发现）：protectState 原来是 ToolCallCard
  // 组件内部的 useState——每张工具卡片是独立实例，用户在一张卡片上点了"开启保护"，
  // 同一 workspace 下其他卡片（旧的、以及点击后新产生的）完全不知道，UI 上仍然显示
  // "不可撤销 + 开启按钮"，用户会以为没生效。改成在 ChatPage 用一个 Set 记录"这一轮
  // 会话里已经点过开启保护的 workspace 路径"，所有 ToolCallCard 共享同一个来源。
  const [protectedWorkspaces, setProtectedWorkspaces] = useState<Set<string>>(new Set());

  /** 右侧工作面板的产出物工件——从 tool_executions 派生，回答完成后刷新 */
  const [artifacts, setArtifacts] = useState<WorkArtifact[]>([]);
  const [toolCallViews, setToolCallViews] = useState<ToolCallView[]>([]);

  // 工具确认流：Promise 化的 requestConfirm + resolveConfirm + 键盘 effect
  const [pendingConfirm, setPendingConfirm] = useState<ToolConfirmRequest | null>(null);
  const confirmResolverRef = useRef<((ok: boolean) => void) | null>(null);

  function requestConfirm(req: ToolConfirmRequest): Promise<boolean> {
    return new Promise((resolve) => {
      setPendingConfirm(req);
      confirmResolverRef.current = resolve;
    });
  }
  function resolveConfirm(ok: boolean): void {
    confirmResolverRef.current?.(ok);
    confirmResolverRef.current = null;
    setPendingConfirm(null);
  }

  // 写操作确认通道：工具运行到写/执行时调 requestConfirm，弹窗等用户按下确认/拒绝
  useEffect(() => {
    if (!pendingConfirm) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        resolveConfirm(false);
      } else if (event.key === "Enter") {
        event.preventDefault();
        resolveConfirm(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // resolveConfirm 是当前组件内函数，引用稳定；此处仅依赖 pendingConfirm 触发挂载/卸载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingConfirm]);

  // 绑定工作文件夹到当前会话并落库（选择器选中 / 拖入文件夹都走这里，单一来源）
  const bindWorkspace = useCallback(async (path: string) => {
    setWorkspacePath(path);
    onConversationWorkspaceChanged(path);
    if (conversationId) {
      try {
        await dbConversations.setWorkspacePath(conversationId, path);
      } catch {
        // 落库失败不阻断（内存态已更新）
      }
    }
  }, [conversationId, onConversationWorkspaceChanged]);

  // 选/换工作文件夹（系统原生目录选择器）
  async function chooseWorkspace(): Promise<void> {
    if (isStreaming) return;
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("chat.workspace.pickTitle"),
      });
      if (typeof picked !== "string") return; // 用户取消
      await bindWorkspace(picked);
    } catch {
      // 选择器异常/取消不阻断对话
    }
  }

  // 解绑工作文件夹，权限退回最安全的只读
  async function clearWorkspace(): Promise<void> {
    if (isStreaming) return;
    setWorkspacePath(null);
    // 权限档不重置——用户的习惯（confirm/auto）跨会话保留，重启也不丢
    onConversationWorkspaceChanged(null);
    if (conversationId) await dbConversations.setWorkspacePath(conversationId, null);
  }

  function applyToolExecutionRows(rows: ToolExecutionRow[]): void {
    setArtifacts(deriveArtifacts(rows));
    setToolCallViews(deriveToolCallViews(rows));
  }

  function clearToolExecutionViews(): void {
    setArtifacts([]);
    setToolCallViews([]);
  }

  return {
    applyToolExecutionRows,
    artifacts,
    bindWorkspace,
    chooseWorkspace,
    clearToolExecutionViews,
    clearWorkspace,
    panelOpen,
    pendingConfirm,
    protectedWorkspaces,
    requestConfirm,
    resolveConfirm,
    setPanelOpen,
    setProtectedWorkspaces,
    setWorkspacePath,
    toolCallViews,
    workspacePath,
  };
}

export type UseWorkPanelReturn = ReturnType<typeof useWorkPanel>;
