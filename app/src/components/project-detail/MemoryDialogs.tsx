import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  memoryKindLabel,
  projectMemories as dbMemories,
  type MemoryKind,
} from "@/lib/db";
import { syncProjectMemoryVector } from "@/lib/memory/retrieval";

const MEMORY_KINDS: readonly MemoryKind[] = ["decision", "lesson", "context", "preference", "other"];

export function AddMemoryDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<MemoryKind>("decision");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setKind("decision");
    setTitle("");
    setContent("");
    setTags("");
    setError(null);
  }

  async function handleSave() {
    if (!title.trim() || !content.trim()) {
      setError(t("projectDetail.addMemory.titleRequired"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await dbMemories.create({
        projectId,
        kind,
        title: title.trim(),
        content: content.trim(),
        tags: tags.trim() || null,
      });
      try {
        await syncProjectMemoryVector(created);
      } catch {
        // 索引失败不影响记忆本身保存成功；后续后台回填会补上
      }
      reset();
      onOpenChange(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projectDetail.addMemory.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass border-white/10 rounded-[2rem]">
        <DialogHeader>
          <DialogTitle className="font-black tracking-tight">{t("projectDetail.addMemory.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {error && (
            <Alert variant="destructive" className="py-2">
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-1.5">
            <Label>{t("projectDetail.addMemory.type")}</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as MemoryKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEMORY_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {memoryKindLabel(k, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mem-title">{t("projectDetail.addMemory.titleLabel")}</Label>
            <Input
              id="mem-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("projectDetail.addMemory.titlePlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mem-content">{t("projectDetail.addMemory.contentLabel")}</Label>
            <Textarea
              id="mem-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={4}
              placeholder={t("projectDetail.addMemory.contentPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mem-tags">{t("projectDetail.addMemory.tagsLabel")}</Label>
            <Input
              id="mem-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder={t("projectDetail.addMemory.tagsPlaceholder")}
            />
            <p className="text-xs text-muted-foreground">{t("projectDetail.addMemory.tagsHint")}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {t("projectDetail.addMemory.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
