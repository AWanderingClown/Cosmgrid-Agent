import { useEffect, useRef, useState, type RefObject } from "react";

/** hook F：输入 + 滚动机制。
 *  持 scrollRef / inputAreaRef / inputAreaH / stickToBottomRef / showJumpToBottom，
 *  提供 scrollToBottom + ResizeObserver + 滚动监听 effect。
 *  不接任何 deps——纯本地 ref + state；messages 变化的自动滚底 effect 归 hook C 流式。 */
export function useChatInput() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const [inputAreaH, setInputAreaH] = useState(180);
  // 实时测量输入框区域高度（含工作区行 + 附件 + 多行文本 + 页脚），驱动消息区底部 padding
  useEffect(() => {
    const el = inputAreaRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setInputAreaH(el.offsetHeight));
    ro.observe(el);
    setInputAreaH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  // 是否「贴底跟随」：用户在底部附近时为 true，自动滚到底；用户往上滚走就为 false，
  // 不再抢鼠标。ref 存实时值给滚动逻辑用，state 仅驱动「回到底部」按钮显隐。
  const stickToBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  // 监听用户滚动：算出离底部的距离，决定是否继续贴底跟随
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distance < 80;
      stickToBottomRef.current = atBottom;
      setShowJumpToBottom(!atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  function scrollToBottom(): void {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
  }

  return {
    inputAreaH,
    inputAreaRef,
    scrollRef,
    scrollToBottom,
    showJumpToBottom,
    stickToBottomRef,
  };
}

export type UseChatInputReturn = ReturnType<typeof useChatInput>;
export type ScrollRef = RefObject<HTMLDivElement | null>;
