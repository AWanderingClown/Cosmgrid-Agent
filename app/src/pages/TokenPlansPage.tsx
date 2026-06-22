// TokenPlansPage - 重构为 "Cosmic Cyber" 视觉风格
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Coins, Trash2, Gauge, Activity, Calendar, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
import {
  tokenPlans as dbTokenPlans,
  providers as dbProviders,
  type TokenPlan,
  type Provider,
} from "@/lib/db";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

const PLAN_TYPE_KEYS = ["monthly", "usage", "message_count", "token_pack", "time_window", "unknown"] as const;
const QUOTA_UNIT_KEYS = ["token", "request", "message", "usd", "time"] as const;

function statusOf(p: TokenPlan, t: (k: string) => string): { label: string; color: string } {
  if (!p.totalQuota) return { label: t("tokenPlans.monitoring"), color: "text-blue-400" };
  const ratio = p.usedQuota / p.totalQuota;
  if (ratio >= 1) return { label: t("tokenPlans.status.exhausted"), color: "text-red-500" };
  if (ratio >= 0.8) return { label: t("tokenPlans.status.warn"), color: "text-orange-500" };
  return { label: t("tokenPlans.status.ok"), color: "text-emerald-400" };
}

export function TokenPlansPage() {
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const [plans, setPlans] = useState<TokenPlan[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState({
    providerId: "",
    name: "",
    planType: "monthly",
    quotaUnit: "usd",
    totalQuota: "",
    resetRule: "",
  });

  async function load() {
    try {
      const [p, pr] = await Promise.all([dbTokenPlans.list(), dbProviders.list()]);
      setPlans(p);
      setProviders(pr);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("common.error"));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate() {
    if (!form.providerId || !form.name) return;
    await dbTokenPlans.create({
      providerId: form.providerId,
      name: form.name,
      planType: form.planType,
      quotaUnit: form.quotaUnit,
      totalQuota: form.totalQuota ? Number(form.totalQuota) : null,
      resetRule: form.resetRule || null,
    });
    setDialogOpen(false);
    setForm({ providerId: "", name: "", planType: "monthly", quotaUnit: "usd", totalQuota: "", resetRule: "" });
    await load();
  }

  async function handleDelete(id: string) {
    if (!(await confirm({ description: t("tokenPlans.deleteConfirm"), destructive: true }))) return;
    await dbTokenPlans.delete(id);
    await load();
  }

  async function handleUsedQuotaChange(p: TokenPlan, value: string) {
    const usedQuota = Number(value);
    if (Number.isNaN(usedQuota)) return;
    await dbTokenPlans.update(p.id, { usedQuota });
    await load();
  }

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <Alert variant="destructive" className="max-w-md bg-red-500/10 border-red-500/20 backdrop-blur-xl">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto p-8 bg-background/30 backdrop-blur-sm custom-scrollbar">
      <div className="space-y-8">
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-primary">
              <Activity className="w-5 h-5" />
              <span className="text-[10px] font-bold uppercase tracking-[0.2em]">{t("tokenPlans.sectionLabel")}</span>
            </div>
            <h1 className="text-3xl font-bold tracking-tight">{t("tokenPlans.title")}</h1>
            <p className="text-muted-foreground text-sm max-w-lg">
              {t("tokenPlans.desc")}
            </p>
          </div>
          <Button
            onClick={() => setDialogOpen(true)}
            disabled={providers.length === 0}
            className="rounded-xl px-6 h-11 bg-primary shadow-lg shadow-primary/20 hover:scale-105 transition-all"
          >
            <Plus className="w-4 h-4 mr-2" />
            {t("tokenPlans.createButton")}
          </Button>
        </header>

        {providers.length === 0 ? (
          <Card className="glass border-dashed p-12 text-center flex flex-col items-center gap-4 rounded-3xl">
            <div className="p-4 bg-amber-500/10 rounded-2xl">
              <ShieldCheck className="w-8 h-8 text-amber-500" />
            </div>
            <div className="space-y-1">
              <h3 className="font-bold">{t("tokenPlans.emptyNoProvider.title")}</h3>
              <p className="text-sm text-muted-foreground">{t("tokenPlans.emptyNoProvider.desc")}</p>
            </div>
          </Card>
        ) : plans.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center glass rounded-3xl border-dashed">
             <Coins className="w-12 h-12 text-muted-foreground/30 mb-4" />
             <p className="text-muted-foreground text-sm">{t("tokenPlans.emptyNoPlan")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {plans.map((p) => {
              const st = statusOf(p, t);
              const ratio = p.totalQuota ? (p.usedQuota / p.totalQuota) * 100 : 0;
              const isHigh = ratio >= 80;

              return (
                <Card key={p.id} className="group glass hover:border-primary/30 transition-all duration-500 rounded-[2rem] overflow-hidden p-0">
                  <div className="p-6 space-y-6">
                    <div className="flex items-start justify-between">
                      <div className="flex gap-4">
                        <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center group-hover:scale-110 transition-transform duration-500">
                          <Gauge className="w-6 h-6 text-primary" />
                        </div>
                        <div>
                          <h3 className="text-lg font-bold tracking-tight group-hover:text-primary transition-colors">{p.name}</h3>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">{p.provider?.name}</span>
                            <div className="w-1 h-1 rounded-full bg-muted-foreground/30" />
                            <span className={cn("text-[10px] font-bold uppercase", st.color)}>{st.label}</span>
                          </div>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(p.id)}
                        className="rounded-xl hover:bg-red-500/10 hover:text-red-500 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>

                    <div className="space-y-3">
                      <div className="flex justify-between items-end px-1">
                        <div className="flex items-baseline gap-1">
                          <span className="text-2xl font-mono font-bold tracking-tighter">
                            {p.usedQuota.toLocaleString()}
                          </span>
                          <span className="text-[10px] font-bold text-muted-foreground uppercase">{p.quotaUnit}</span>
                        </div>
                        <div className="text-[10px] font-bold text-muted-foreground/60 uppercase">
                           {p.totalQuota ? t("tokenPlans.limit", { value: p.totalQuota.toLocaleString() }) : t("tokenPlans.limitUnlimited")}
                        </div>
                      </div>

                      <div className="relative h-2.5 w-full bg-muted/30 rounded-full overflow-hidden">
                        <div
                          className={cn(
                            "absolute inset-y-0 left-0 rounded-full transition-all duration-1000 ease-out",
                            isHigh ? "bg-gradient-to-r from-orange-400 to-red-500" : "bg-gradient-to-r from-blue-400 to-primary"
                          )}
                          style={{ width: `${Math.min(100, ratio)}%` }}
                        />
                        {isHigh && <div className="absolute inset-0 shimmer-bg opacity-30" />}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2 pt-2">
                      <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-muted/50 text-[10px] font-bold text-muted-foreground uppercase border border-white/5">
                        <Activity className="w-3 h-3" />
                        {PLAN_TYPE_KEYS.includes(p.planType as typeof PLAN_TYPE_KEYS[number])
                          ? t(`tokenPlans.types.${p.planType}`)
                          : t("tokenPlans.custom")}
                      </div>
                      {p.resetRule && (
                        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-muted/50 text-[10px] font-bold text-muted-foreground uppercase border border-white/5">
                          <Calendar className="w-3 h-3" />
                          {t("tokenPlans.reset", { rule: p.resetRule })}
                        </div>
                      )}

                      <div className="ml-auto flex items-center gap-2">
                        <span className="text-[10px] font-bold text-muted-foreground/40 uppercase">{t("tokenPlans.used")}</span>
                        <Input
                          type="number"
                          defaultValue={p.usedQuota}
                          onBlur={(e) => void handleUsedQuotaChange(p, e.target.value)}
                          className="h-7 w-20 text-[10px] font-mono bg-white/5 border-white/10 rounded-lg focus:ring-primary/20"
                        />
                      </div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="glass border-white/10 rounded-[2rem] max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2">
              <Plus className="w-5 h-5 text-primary" />
              {t("tokenPlans.createDialog.title")}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-5 py-4">
            <div className="space-y-2">
              <Label className="text-[10px] font-bold uppercase tracking-widest px-1">{t("tokenPlans.createDialog.provider")}</Label>
              <Select value={form.providerId} onValueChange={(v) => setForm({ ...form, providerId: v })}>
                <SelectTrigger className="rounded-xl border-white/10 bg-white/5 h-11">
                  <SelectValue placeholder={t("tokenPlans.createDialog.providerPlaceholder")} />
                </SelectTrigger>
                <SelectContent className="glass border-white/10 rounded-xl">
                  {providers.map((pr) => (
                    <SelectItem key={pr.id} value={pr.id} className="rounded-lg">{pr.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-[10px] font-bold uppercase tracking-widest px-1">{t("tokenPlans.createDialog.name")}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t("tokenPlans.createDialog.namePlaceholder")}
                className="rounded-xl border-white/10 bg-white/5 h-11"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-[10px] font-bold uppercase tracking-widest px-1">{t("tokenPlans.createDialog.type")}</Label>
                <Select value={form.planType} onValueChange={(v) => setForm({ ...form, planType: v })}>
                  <SelectTrigger className="rounded-xl border-white/10 bg-white/5 h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="glass border-white/10 rounded-xl">
                    {PLAN_TYPE_KEYS.map((k) => (
                      <SelectItem key={k} value={k} className="rounded-lg">{t(`tokenPlans.types.${k}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-[10px] font-bold uppercase tracking-widest px-1">{t("tokenPlans.createDialog.unit")}</Label>
                <Select value={form.quotaUnit} onValueChange={(v) => setForm({ ...form, quotaUnit: v })}>
                  <SelectTrigger className="rounded-xl border-white/10 bg-white/5 h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="glass border-white/10 rounded-xl">
                    {QUOTA_UNIT_KEYS.map((k) => (
                      <SelectItem key={k} value={k} className="rounded-lg">{t(`tokenPlans.units.${k}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-[10px] font-bold uppercase tracking-widest px-1">{t("tokenPlans.createDialog.total")}</Label>
                <Input
                  type="number"
                  value={form.totalQuota}
                  onChange={(e) => setForm({ ...form, totalQuota: e.target.value })}
                  placeholder={t("tokenPlans.createDialog.totalPlaceholder")}
                  className="rounded-xl border-white/10 bg-white/5 h-11"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-[10px] font-bold uppercase tracking-widest px-1">{t("tokenPlans.createDialog.resetRule")}</Label>
                <Input
                  value={form.resetRule}
                  onChange={(e) => setForm({ ...form, resetRule: e.target.value })}
                  placeholder={t("tokenPlans.createDialog.resetPlaceholder")}
                  className="rounded-xl border-white/10 bg-white/5 h-11"
                />
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" onClick={() => setDialogOpen(false)} className="rounded-xl h-11">
              {t("common.cancel")}
            </Button>
            <Button onClick={handleCreate} className="rounded-xl h-11 px-8 bg-primary shadow-lg shadow-primary/20">
              {t("tokenPlans.createDialog.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
