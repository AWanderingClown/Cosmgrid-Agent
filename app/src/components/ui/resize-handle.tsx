// 极简手写拖拽分隔条（替代 react-resizable-panels）
// 设计要点：
// 1. 拖动时只在 window 上临时挂 mousemove/mouseup，松手立即移除——绝不留全屏遮罩，
//    所以永远不会拦截其他元素的点击（这是上一版库实现的坑）。
// 2. 像素宽度 + min/max 夹紧，调用方用 style={{ width }} 控制相邻面板宽度。
// 3. 命中区比视觉宽一点，好抓；默认不画分割线，避免破坏主界面留白。
import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface UsePanelResizeOptions {
  /** 初始宽度（px） */
  initial: number;
  /** 最小宽度（px） */
  min: number;
  /** 最大宽度（px） */
  max: number;
  /**
   * 分隔条在被控面板的哪一侧：
   * - "right"：分隔条在面板右边（如左侧栏），向右拖 = 变宽
   * - "left"：分隔条在面板左边（如右侧工作面板），向左拖 = 变宽
   */
  edge: "right" | "left";
}

export function usePanelResize(opts: UsePanelResizeOptions) {
  const [width, setWidth] = useState(opts.initial);
  const startRef = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      startRef.current = width;

      const move = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const raw = opts.edge === "right" ? startRef.current + dx : startRef.current - dx;
        setWidth(Math.min(opts.max, Math.max(opts.min, raw)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    },
    [width, opts.edge, opts.min, opts.max],
  );

  return { width, onMouseDown, setWidth };
}

interface ResizeHandleProps {
  onMouseDown: (e: React.MouseEvent) => void;
  className?: string;
}

/** 可拖拽的竖向分隔条：默认透明，只在 hover 时显示中央把手，拖动能力保留。 */
export function ResizeHandle({ onMouseDown, className }: ResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={onMouseDown}
      className={cn(
        "group relative w-3 shrink-0 cursor-col-resize flex items-center justify-center",
        className,
      )}
    >
      {/* hover 时中央显示的把手圆点（明确告诉用户"这里能拖"） */}
      <div className="relative w-1 h-12 rounded-full bg-zinc-400/70 dark:bg-white/40 opacity-0 group-hover:opacity-100 transition-opacity" />
    </div>
  );
}
