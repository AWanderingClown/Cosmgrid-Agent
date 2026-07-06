import { HelpCircle } from "lucide-react";
import type { AskUserRequest } from "@/lib/llm/tools";

/**
 * ask_user_question 工具的交互卡片——跟 ToolConfirmCard 同一个视觉语系（贴输入框，不额外
 * 悬浮），但内容更丰富：问题文本 + 2-4 个选项按钮（可带说明）。点选项即 resolve，不需要
 * 二次确认——选错了用户可以在下一轮对话里直接跟模型说。
 */
export function AskUserCard({
  request,
  onResolve,
}: {
  request: AskUserRequest;
  onResolve: (answer: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-primary/25 bg-primary/5 px-3 py-2.5 text-[11px]">
      <div className="flex items-center gap-1.5 font-semibold text-primary">
        <HelpCircle className="h-3 w-3 shrink-0" />
        <span className="truncate">{request.question}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {request.options.map((opt) => (
          <button
            key={opt.label}
            type="button"
            title={opt.description}
            onClick={() => onResolve(opt.label)}
            className="rounded-lg border border-primary/20 bg-background/80 px-2.5 py-1 font-medium text-foreground/80 transition-colors hover:border-primary/50 hover:bg-primary/10 hover:text-primary"
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
