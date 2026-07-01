import { FolderOpen, Paperclip, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Attachment } from "@/lib/llm/attachments";

export function QueuedMessageItem({ text, attachments }: { text: string; attachments?: Attachment[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-4 px-6 py-4 opacity-50">
      <div className="flex max-w-4xl mx-auto w-full gap-5">
        <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-primary to-blue-600 text-primary-foreground flex items-center justify-center shrink-0 rotate-[-6deg]">
          <User className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-widest text-amber-500/70">{t("chat.queued")}</span>
          <div className="text-sm text-foreground/80 whitespace-pre-wrap break-words">{text}</div>
          {attachments && attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((a) =>
                a.kind === "image" ? (
                  <img key={a.id} src={a.dataUrl} alt={a.name} className="w-10 h-10 object-cover rounded-md border border-white/10" />
                ) : a.kind === "folder" ? (
                  <span key={a.id} className="inline-flex items-center gap-1 text-[10px] bg-primary/10 text-primary rounded-md px-1.5 py-0.5 border border-primary/30">
                    <FolderOpen className="w-2.5 h-2.5" /> {a.name}
                  </span>
                ) : (
                  <span key={a.id} className="inline-flex items-center gap-1 text-[10px] bg-white/10 rounded-md px-1.5 py-0.5">
                    <Paperclip className="w-2.5 h-2.5" /> {a.name}
                  </span>
                ),
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
