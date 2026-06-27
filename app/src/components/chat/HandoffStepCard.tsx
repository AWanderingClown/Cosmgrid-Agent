// 阶段4 T22-2C — Handoff 每跳 agent 流式输出卡片
//
// 显示在主对话流中，每跳 agent 独立一条消息（不追加到 main chat 的 fullContent）。
// 当前 agent 流式时显示 done=false；agent 跑完（onStepDone）切到 done=true。

import { useTranslation } from "react-i18next";
import { Loader2, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface HandoffStepCardProps {
  agentId: string;
  content: string;
  done: boolean;
  className?: string;
}

export function HandoffStepCard({ agentId, content, done, className }: HandoffStepCardProps) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="handoff-step-card"
      data-agent-id={agentId}
      className={cn(
        "flex flex-col gap-1 rounded-md border border-primary/20 bg-primary/5 px-3 py-2",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {done ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
        ) : (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        )}
        <span className="font-mono text-primary">{agentId}</span>
        <span>{done ? t("chat.handoff.stepDone") : t("chat.handoff.stepStreaming")}</span>
      </div>
      <div className="whitespace-pre-wrap text-sm">{content}</div>
    </div>
  );
}