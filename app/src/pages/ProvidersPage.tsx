// ProvidersPage - API 接入 + 模型池
// v0.3：apiFetch → db.ts 直连 SQLite
import { useEffect, useState } from "react";
import { Plus, KeyRound, Layers, Trash2 } from "lucide-react";
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

export function ProvidersPage() {
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
      console.error("[providers] load 失败:", err);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleDeleteProvider(id: string) {
    if (!confirm("确定删除这个 Provider？关联的凭证和模型也会被删除")) return;
    try {
      await dbProviders.delete(id);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "删除失败");
    }
  }

  async function handleDeleteCredential(id: string) {
    if (!confirm("确定删除这个凭证？")) return;
    try {
      await dbCredentials.delete(id);
      await deleteApiKey(id);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "删除失败");
    }
  }

  async function handleDeleteModel(id: string) {
    if (!confirm("确定删除这个模型？")) return;
    try {
      await dbModels.delete(id);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "删除失败");
    }
  }

  async function toggleModelEnabled(m: ModelListItem) {
    try {
      await dbModels.update(m.id, { enabled: !m.enabled });
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "更新失败");
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <KeyRound className="w-5 h-5" />
            API 接入
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            管理 Provider、凭证、模型。点 + 添加一个完整配置（含默认模型）
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="w-4 h-4 mr-2" />
          添加供应商
        </Button>
      </div>

      {providers.length === 0 ? (
        <Card className="p-12 text-center">
          <p className="text-muted-foreground">还没有添加任何 Provider</p>
        </Card>
      ) : (
        <Accordion type="multiple" className="space-y-2">
          {providers.map((p) => {
            const pCreds = credentials.filter((c) => c.providerId === p.id);
            const pModels = models.filter((m) => m.providerId === p.id);
            return (
              <AccordionItem key={p.id} value={p.id} className="border rounded-lg px-4 bg-card">
                <AccordionTrigger className="hover:no-underline">
                  <div className="flex items-center gap-3 flex-1">
                    <span className="font-semibold">{p.name}</span>
                    <Badge variant="secondary">{p.type}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {pCreds.length} 凭证 · {pModels.length} 模型
                    </span>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="space-y-4 pt-2">
                  <div>
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <KeyRound className="w-3 h-3" /> 凭证
                    </h4>
                    {pCreds.length === 0 ? (
                      <p className="text-xs text-muted-foreground">无凭证</p>
                    ) : (
                      <div className="space-y-1">
                        {pCreds.map((c) => (
                          <div
                            key={c.id}
                            className="flex items-center justify-between text-sm bg-muted/30 rounded px-3 py-2"
                          >
                            <div>
                              <span>{c.name}</span>
                              <span className="text-xs text-muted-foreground ml-2 font-mono">
                                {c.baseUrl}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge variant={c.enabled ? "default" : "outline"}>
                                {c.enabled ? "启用" : "禁用"}
                              </Badge>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDeleteCredential(c.id)}
                              >
                                <Trash2 className="w-3 h-3" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <Layers className="w-3 h-3" /> 模型
                    </h4>
                    {pModels.length === 0 ? (
                      <p className="text-xs text-muted-foreground">无模型</p>
                    ) : (
                      <div className="space-y-1">
                        {pModels.map((m) => {
                          const roles = parseWorkRoles(m.workRoles);
                          return (
                            <div
                              key={m.id}
                              className="flex items-center justify-between text-sm bg-muted/30 rounded px-3 py-2"
                            >
                              <div className="flex items-center gap-2">
                                <span className="font-mono">{m.name}</span>
                                {m.displayName && (
                                  <span className="text-xs text-muted-foreground">
                                    ({m.displayName})
                                  </span>
                                )}
                                <div className="flex gap-1">
                                  {roles.slice(0, 3).map((r) => (
                                    <Badge key={r} variant="outline" className="text-xs">
                                      {r}
                                    </Badge>
                                  ))}
                                  {roles.length > 3 && (
                                    <Badge variant="outline" className="text-xs">
                                      +{roles.length - 3}
                                    </Badge>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => toggleModelEnabled(m)}
                                >
                                  {m.enabled ? "禁用" : "启用"}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleDeleteModel(m.id)}
                                >
                                  <Trash2 className="w-3 h-3" />
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="flex justify-end pt-2 border-t">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteProvider(p.id)}
                      className="text-destructive"
                    >
                      <Trash2 className="w-3 h-3 mr-1" />
                      删除整个 Provider
                    </Button>
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      )}

      <AddProviderDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSuccess={load}
      />
    </div>
  );
}
