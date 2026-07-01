import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { ToolConfirmRequest } from "@/lib/llm/tools";

export function ToolConfirmCard({
  request,
  onResolve,
}: {
  request: ToolConfirmRequest;
  onResolve: (ok: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="absolute top-5 right-5 z-50 w-[24rem] max-w-[calc(100%-2.5rem)]">
      <div className="glass border border-white/15 rounded-[1.75rem] overflow-hidden shadow-2xl shadow-black/35">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10 bg-black/20">
          <ShieldAlert className="w-4 h-4 text-amber-500" />
          <span className="font-bold text-sm">{t("chat.tools.confirmTitle")}</span>
          <span className="ml-auto text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-500 uppercase">{request.toolName}</span>
        </div>
        <div className="px-4 py-3 space-y-3">
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t("chat.tools.confirmHint")}
          </p>
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-white/10 bg-black/10">
          <Button variant="outline" size="sm" className="rounded-xl" onClick={() => onResolve(false)}>
            {t("chat.tools.reject")}
          </Button>
          <Button size="sm" className="rounded-xl bg-emerald-600 hover:bg-emerald-700" onClick={() => onResolve(true)}>
            {t("chat.tools.approve")}
          </Button>
        </div>
      </div>
    </div>
  );
}
