import { useEffect, useRef, useState } from "react";
import { type Conversation } from "@/lib/db";

export interface UseConversationsOptions {
  // 阶段 8：hook A 纯 state 持有，无 deps
}

/** hook A：会话管理。
 *  持 conversationId / conversationList state + conversationIdRef，
 *  暴露 setConversationId / setConversationList 给 ChatPage 协调层（handleNewChat/switchConversation/
 *  handleDeleteConversation）调用。
 *  跨 hook 写走回调（hook E 改 workspacePath + hook B 改 defaultModelId 通过 onConversationXxxChanged
 *  回调由 ChatPage 协调层实现）。 */
export function useConversations(_opts: UseConversationsOptions = {}) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationList, setConversationList] = useState<Conversation[]>([]);
  const conversationIdRef = useRef<string | null>(null);

  // 镜像 conversationId 到 ref，供后台编排回调判断"用户是否已切走会话"
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  return {
    conversationId,
    conversationIdRef,
    conversationList,
    setConversationId,
    setConversationList,
  };
}

export type UseConversationsReturn = ReturnType<typeof useConversations>;
