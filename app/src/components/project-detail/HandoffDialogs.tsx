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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WORK_ROLES } from "@/lib/api";
import {
  handoffPackets as dbHandoffs,
  type Checkpoint,
  type HandoffPacket,
} from "@/lib/db";
import { formatTime, roleLabel } from "./project-detail-utils";

export function GenerateHandoffDialog({
  open,
  onOpenChange,
  checkpoint,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  checkpoint: Checkpoint | null;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [targetRole, setTargetRole] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate() {
    if (!checkpoint || !targetRole) return;
    setSaving(true);
    setError(null);
    try {
      await dbHandoffs.generate(checkpoint.id, targetRole, t);
      setTargetRole("");
      onOpenChange(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projectDetail.generateHandoff.failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass border-white/10 rounded-[2rem]">
        <DialogHeader>
          <DialogTitle className="font-black tracking-tight">{t("projectDetail.generateHandoff.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {error && (
            <Alert variant="destructive" className="py-2">
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}
          {checkpoint && (
            <div className="text-xs text-muted-foreground">
              {t("projectDetail.generateHandoff.sourceCheckpoint")}<span className="font-medium text-foreground">{checkpoint.title}</span>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{t("projectDetail.generateHandoff.targetRole")}</Label>
            <Select value={targetRole} onValueChange={setTargetRole}>
              <SelectTrigger>
                <SelectValue placeholder={t("projectDetail.generateHandoff.targetRolePlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {WORK_ROLES.map((role) => (
                  <SelectItem key={role} value={role}>
                    {t(`workRoles.${role}`)}（{t(`workRoles.${role}_desc`)}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="text-xs text-muted-foreground">
            {t("projectDetail.generateHandoff.hint")}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void handleGenerate()} disabled={saving || !targetRole}>
            {saving ? t("projectDetail.generateHandoff.generating") : t("projectDetail.generateHandoff.generate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function HandoffDetailDialog({
  packet,
  open,
  onOpenChange,
}: {
  packet: HandoffPacket | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  if (!packet) return null;
  const targetRoleLabel = roleLabel(packet.targetRole, t) ?? packet.targetRole;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto glass border-white/10 rounded-[2rem]">
        <DialogHeader>
          <DialogTitle className="font-black tracking-tight">{t("projectDetail.handoffDetail.title", { role: targetRoleLabel })}</DialogTitle>
        </DialogHeader>
        <div className="text-xs text-muted-foreground">{t("projectDetail.handoffDetail.generatedAt", { time: formatTime(packet.createdAt) })}</div>
        <pre className="bg-muted rounded-xl p-3 text-xs whitespace-pre-wrap break-words font-mono">
          {packet.content}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
