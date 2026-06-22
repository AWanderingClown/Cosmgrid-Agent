// ProvidersPage - 重构为 "Cosmic Cyber" 视觉风格
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, KeyRound, Layers, Trash2, Cpu, Globe, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { AddProviderDialog } from "@/components/providers/AddProviderDialog";
import { type ProviderListItem, type CredentialListItem, type ModelListItem, parseWorkRoles } from "@/lib/api";
import { providers as dbProviders, apiCredentials as dbCredentials, models as dbModels } from "@/lib/db";
import { deleteApiKey } from "@/lib/keystore";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

export function ProvidersPage() {
  const { t } = useTranslation();
  const { confirm, alert } = useConfirm();
  const [providers, setProviders] = useState<ProviderListItem[]>([]);
  const [credentials, setCredentials] = useState<CredentialListItem[]>([]);
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);

  async function load() {
    try {
      const [p, c, m] = await Promise.all([
        dbProviders.list(),
        dbCredentials.list(),
        dbModels.listEnabled(),
      ]);
      setProviders(p);
      setCredentials(
        c.map((cr) => ({
          id: cr.id,
          name: cr.name,
          baseUrl: cr.baseUrl,
          enabled: cr.enabled,
          providerId: cr.providerId,
          provider: cr.provider ?? { name: "", type: "" },
          defaultModelId: cr.defaultModelId,
        }))
      );
      setModels(
        m.map((mo) => ({
          id: mo.id,
          name: mo.name,
          displayName: mo.displayName,
          contextWindow: mo.contextWindow,
          enabled: mo.enabled,
          workRoles: mo.workRoles,
          capabilityScore: mo.capabilityScore,
          providerId: mo.providerId,
          provider: mo.provider,
        }))
      );
    } catch (err) {
      console.error("[providers] load failed:", err);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleDeleteProvider(id: string) {
    if (!(await confirm({ description: t("providers.deleteProvider"), destructive: true }))) return;
    try {
      await dbProviders.delete(id);
      await load();
    } catch (err) {
      await alert({ description: err instanceof Error ? err.message : t("providers.deleteFailed") });
    }
  }

  async function handleDeleteCredential(id: string) {
    if (!(await confirm({ description: t("providers.deleteCredential"), destructive: true }))) return;
    try {
      await dbCredentials.delete(id);
      await deleteApiKey(id);
      await load();
    } catch (err) {
      await alert({ description: err instanceof Error ? err.message : t("providers.deleteFailed") });
    }
  }

  async function handleDeleteModel(id: string) {
    if (!(await confirm({ description: t("providers.deleteModel"), destructive: true }))) return;
    try {
      await dbModels.delete(id);
      await load();
    } catch (err) {
      await alert({ description: err instanceof Error ? err.message : t("providers.deleteFailed") });
    }
  }

  async function toggleModelEnabled(m: ModelListItem) {
    try {
      await dbModels.update(m.id, { enabled: !m.enabled });
      await load();
    } catch (err) {
      await alert({ description: err instanceof Error ? err.message : t("providers.updateFailed") });
    }
  }

  return (
    <div className="h-full w-full overflow-y-auto p-8 bg-background/30 backdrop-blur-sm custom-scrollbar">
      <div className="space-y-10">
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-primary">
              <KeyRound className="w-5 h-5" />
              <span className="text-[10px] font-bold uppercase tracking-[0.2em]">{t("providers.sectionLabel")}</span>
            </div>
            <h1 className="text-4xl font-black tracking-tight">{t("providers.title")}</h1>
            <p className="text-muted-foreground text-sm max-w-xl">
              {t("providers.desc")}
            </p>
          </div>
          <Button
            onClick={() => setDialogOpen(true)}
            className="rounded-2xl px-8 h-12 bg-primary shadow-xl shadow-primary/20 hover:scale-105 transition-all font-bold"
          >
            <Plus className="w-5 h-5 mr-2" />
            {t("providers.addButton")}
          </Button>
        </header>

        {providers.length === 0 ? (
          <Card className="glass border-dashed p-20 text-center flex flex-col items-center gap-6 rounded-[2.5rem]">
            <div className="w-20 h-20 bg-muted/30 rounded-[2rem] flex items-center justify-center animate-pulse">
              <Globe className="w-10 h-10 text-muted-foreground/30" />
            </div>
            <div className="space-y-2">
              <h3 className="text-xl font-bold">{t("providers.empty.title")}</h3>
              <p className="text-sm text-muted-foreground max-w-xs">{t("providers.empty.desc")}</p>
            </div>
          </Card>
        ) : (
          <Accordion type="multiple" className="space-y-4">
            {providers.map((p) => {
              const pCreds = credentials.filter((c) => c.providerId === p.id);
              const pModels = models.filter((m) => m.providerId === p.id);
              return (
                <AccordionItem
                  key={p.id}
                  value={p.id}
                  className="glass border-white/10 rounded-[2rem] px-6 transition-all duration-500 hover:border-primary/20 data-[state=open]:border-primary/30 shadow-sm"
                >
                  <AccordionTrigger className="hover:no-underline py-6">
                    <div className="flex items-center gap-5 flex-1 text-left">
                      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center border border-white/5">
                        <Cpu className="w-6 h-6 text-primary" />
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-3">
                          <span className="text-lg font-bold tracking-tight">{p.name}</span>
                          <Badge variant="outline" className="bg-white/5 border-white/10 text-[10px] font-bold uppercase tracking-widest h-5">
                            {p.type}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-3 text-[10px] font-bold text-muted-foreground/50 uppercase tracking-wider">
                          <span className="flex items-center gap-1">
                            <KeyRound className="w-3 h-3" /> {pCreds.length} {t("providers.credentials")}
                          </span>
                          <span className="flex items-center gap-1">
                            <Layers className="w-3 h-3" /> {pModels.length} {t("providers.models")}
                          </span>
                        </div>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="pb-8 space-y-8 animate-in fade-in slide-in-from-top-2 duration-500">

                    {/* 凭证部分 */}
                    <div className="space-y-4">
                      <div className="flex items-center justify-between px-2">
                        <h4 className="text-xs font-bold uppercase tracking-widest text-primary flex items-center gap-2">
                          <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                          {t("providers.credentialsList")}
                        </h4>
                      </div>
                      {pCreds.length === 0 ? (
                        <div className="bg-white/5 rounded-2xl p-4 text-center border border-dashed border-white/10">
                          <p className="text-xs text-muted-foreground">{t("providers.noCredentials")}</p>
                        </div>
                      ) : (
                        <div className="grid gap-3">
                          {pCreds.map((c) => (
                            <div
                              key={c.id}
                              className="group flex items-center justify-between bg-white/5 border border-white/5 hover:border-white/10 rounded-2xl p-4 transition-all"
                            >
                              <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                  <span className="font-bold text-sm">{c.name}</span>
                                  {c.enabled ? (
                                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                                  ) : (
                                    <XCircle className="w-3.5 h-3.5 text-muted-foreground" />
                                  )}
                                </div>
                                <div className="text-[10px] font-mono text-muted-foreground/60 bg-black/20 px-2 py-0.5 rounded w-fit">
                                  {c.baseUrl || t("providers.defaultEndpoint")}
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleDeleteCredential(c.id)}
                                  className="rounded-xl hover:bg-red-500/10 hover:text-red-500"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 模型部分 */}
                    <div className="space-y-4">
                      <div className="flex items-center justify-between px-2">
                        <h4 className="text-xs font-bold uppercase tracking-widest text-accent flex items-center gap-2">
                          <div className="w-1.5 h-1.5 rounded-full bg-accent" />
                          {t("providers.modelsPool")}
                        </h4>
                      </div>
                      {pModels.length === 0 ? (
                        <div className="bg-white/5 rounded-2xl p-4 text-center border border-dashed border-white/10">
                          <p className="text-xs text-muted-foreground">{t("providers.noModels")}</p>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {pModels.map((m) => {
                            const roles = parseWorkRoles(m.workRoles);
                            return (
                              <div
                                key={m.id}
                                className="group flex flex-col justify-between bg-white/5 border border-white/5 hover:border-primary/20 rounded-2xl p-5 transition-all gap-4"
                              >
                                <div className="space-y-3">
                                  <div className="flex items-start justify-between">
                                    <div className="space-y-1">
                                      <div className="font-mono text-sm font-bold tracking-tighter truncate max-w-[180px]">
                                        {m.name}
                                      </div>
                                      <div className="text-[10px] font-medium text-muted-foreground/60">
                                        {m.displayName || t("providers.defaultModelLabel")}
                                      </div>
                                    </div>
                                    <Badge
                                      variant={m.enabled ? "default" : "outline"}
                                      className={cn(
                                        "text-[9px] uppercase font-black px-1.5 py-0 h-4",
                                        m.enabled ? "bg-emerald-500/20 text-emerald-500 border-none" : "border-white/10 text-muted-foreground/50"
                                      )}
                                    >
                                      {m.enabled ? t("providers.online") : t("providers.offline")}
                                    </Badge>
                                  </div>
                                  <div className="flex flex-wrap gap-1.5">
                                    {roles.slice(0, 4).map((r) => (
                                      <div key={r} className="px-2 py-0.5 bg-black/20 text-[9px] font-bold text-muted-foreground/80 rounded-md uppercase tracking-tight">
                                        {t(`workRoles.${r}`, { defaultValue: r })}
                                      </div>
                                    ))}
                                    {roles.length > 4 && (
                                      <div className="px-2 py-0.5 bg-black/20 text-[9px] font-bold text-muted-foreground/40 rounded-md">
                                        +{roles.length - 4}
                                      </div>
                                    )}
                                  </div>
                                </div>
                                <div className="flex items-center justify-between pt-2 border-t border-white/5">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => toggleModelEnabled(m)}
                                    className="h-8 text-[10px] font-bold uppercase tracking-widest hover:bg-white/5"
                                  >
                                    {m.enabled ? t("providers.disable") : t("providers.enable")}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => handleDeleteModel(m.id)}
                                    className="h-8 w-8 rounded-lg hover:bg-red-500/10 hover:text-red-500"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="flex justify-end pt-6 border-t border-white/10">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDeleteProvider(p.id)}
                        className="text-[10px] font-bold uppercase tracking-widest text-red-500/60 hover:text-red-500 hover:bg-red-500/10 rounded-xl px-4"
                      >
                        <AlertCircle className="w-3.5 h-3.5 mr-2" />
                        {t("providers.deleteProviderFull")}
                      </Button>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        )}
      </div>

      <AddProviderDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSuccess={load}
      />
    </div>
  );
}
