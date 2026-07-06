// 供应商页的编辑弹窗——按 target 类型编辑供应商名 / 凭证(名+baseUrl+API Key) / 模型参数。
// 单组件 + discriminated target，ProvidersPage 只需持一个 editTarget state。
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type ProviderListItem,
  type CredentialListItem,
  type ModelListItem,
  type WorkRole,
  parseWorkRoles,
} from "@/lib/api";
import { providers as dbProviders, apiCredentials as dbCredentials, models as dbModels } from "@/lib/db";
import { saveApiKey } from "@/lib/keystore";
import { ApiKeyInput } from "./ApiKeyInput";
import { WorkRoleSelector } from "./WorkRoleSelector";
import { saveManualModelPrice } from "@/lib/llm/price-catalog";
import { isCliType } from "./provider-form-defaults";
import type { ProviderTypeValue } from "./ProviderTypeSelect";

export type EditTarget =
  | { kind: "provider"; data: ProviderListItem }
  | { kind: "credential"; data: CredentialListItem }
  | { kind: "model"; data: ModelListItem };

interface ProviderEditDialogProps {
  target: EditTarget | null;
  onClose: () => void;
  onSaved: () => void;
}

export function ProviderEditDialog({ target, onClose, onSaved }: ProviderEditDialogProps) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [contextWindow, setContextWindow] = useState(0);
  const [inputPrice, setInputPrice] = useState(0);
  const [outputPrice, setOutputPrice] = useState(0);
  const [workRoles, setWorkRoles] = useState<WorkRole[]>([]);
  const [resolvingCliPath, setResolvingCliPath] = useState(false);
  const [cliPathDetected, setCliPathDetected] = useState(false);

  // target 变化时用当前值预填表单
  useEffect(() => {
    if (!target) return;
    setError(null);
    setApiKey("");
    setCliPathDetected(false);
    if (target.kind === "provider") {
      setName(target.data.name);
    } else if (target.kind === "credential") {
      setName(target.data.name);
      setBaseUrl(target.data.baseUrl ?? "");
    } else {
      setDisplayName(target.data.displayName ?? "");
      setContextWindow(target.data.contextWindow ?? 0);
      setInputPrice(target.data.inputPrice ?? 0);
      setOutputPrice(target.data.outputPrice ?? 0);
      setWorkRoles(parseWorkRoles(target.data.workRoles) as WorkRole[]);
    }
  }, [target]);

  // 2026-07-05 加：编辑已有 CLI 凭据时也能重新检测可执行文件路径——原来只有新建供应商
  // 时（AddProviderDialog）才有这个按钮，路径一旦失效（重装/换了 nvm 版本）用户只能手动
  // 改，没法重新自动搜索，只能删了重建。
  async function detectCliPath() {
    if (!target || target.kind !== "credential") return;
    const providerType = target.data.provider.type as ProviderTypeValue;
    if (!isCliType(providerType)) return;
    const program = providerType === "claude-cli" ? "claude" : "codex";
    setResolvingCliPath(true);
    setCliPathDetected(false);
    try {
      const resolved = await invoke<string | null>("resolve_cli_program", { program });
      if (resolved) {
        setBaseUrl(resolved);
        setCliPathDetected(true);
      }
    } catch {
      // 检测失败保留原值，用户可以手动改
    } finally {
      setResolvingCliPath(false);
    }
  }

  async function handleSave() {
    if (!target) return;
    setSaving(true);
    setError(null);
    try {
      if (target.kind === "provider") {
        if (!name.trim()) throw new Error(t("addProvider.fillRequired"));
        await dbProviders.update(target.data.id, { name: name.trim() });
      } else if (target.kind === "credential") {
        if (!name.trim()) throw new Error(t("addProvider.fillRequired"));
        await dbCredentials.update(target.data.id, { name: name.trim(), baseUrl: baseUrl.trim() });
        // 留空 = 保留原 Key；填了才覆盖
        if (apiKey.trim()) await saveApiKey(target.data.id, apiKey.trim());
      } else {
        await dbModels.update(target.data.id, {
          displayName: displayName.trim() || null,
          contextWindow: contextWindow || null,
          inputPrice: inputPrice > 0 ? inputPrice : null,
          outputPrice: outputPrice > 0 ? outputPrice : null,
          workRoles: JSON.stringify(workRoles),
        });
        if (inputPrice > 0 && outputPrice > 0) {
          await saveManualModelPrice({
            modelName: target.data.name,
            providerType: target.data.provider?.type,
            inputPer1m: inputPrice,
            outputPer1m: outputPrice,
            contextWindow: contextWindow || null,
          });
        }
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("providers.updateFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="glass border-white/10 rounded-2xl max-w-lg">
        <DialogHeader>
          <DialogTitle>{target ? t(`providers.edit.${target.kind}Title`) : ""}</DialogTitle>
          <DialogDescription>{target ? t(`providers.edit.${target.kind}Desc`) : ""}</DialogDescription>
        </DialogHeader>

        {target && (
          <div className="space-y-5 py-1">
            {target.kind === "provider" && (
              <Field label={t("providers.edit.nameLabel")}>
                <Input value={name} onChange={(e) => setName(e.target.value)} className="rounded-xl" />
              </Field>
            )}

            {target.kind === "credential" && (
              <>
                <Field label={t("providers.edit.nameLabel")}>
                  <Input value={name} onChange={(e) => setName(e.target.value)} className="rounded-xl" />
                </Field>
                <Field label={isCliType(target.data.provider.type as ProviderTypeValue) ? t("addProvider.cliPathLabel") : t("addProvider.baseUrl")}>
                  <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="rounded-xl font-mono text-xs" />
                </Field>
                {isCliType(target.data.provider.type as ProviderTypeValue) && (
                  <div className="flex items-center justify-between gap-3 -mt-3">
                    <p className="text-xs text-muted-foreground">
                      {cliPathDetected
                        ? t("addProvider.cliDetected")
                        : resolvingCliPath
                          ? t("addProvider.cliDetecting")
                          : t("addProvider.cliHint")}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void detectCliPath()}
                      disabled={resolvingCliPath}
                      className="shrink-0 rounded-xl"
                    >
                      {resolvingCliPath ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                      {t("addProvider.cliDetectButton")}
                    </Button>
                  </div>
                )}
                <div className="space-y-1">
                  <ApiKeyInput value={apiKey} onChange={setApiKey} placeholder={t("providers.edit.apiKeyKeep")} />
                  <p className="text-[10px] text-muted-foreground/60 px-1">{t("providers.edit.apiKeyHint")}</p>
                </div>
              </>
            )}

            {target.kind === "model" && (
              <>
                <Field label={t("providers.edit.displayNameLabel")}>
                  <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="rounded-xl" />
                </Field>
                <Field label={t("providers.edit.contextWindowLabel")}>
                  <Input
                    type="number"
                    value={contextWindow}
                    onChange={(e) => setContextWindow(Number(e.target.value) || 0)}
                    className="rounded-xl"
                  />
                </Field>
                <Field label={t("addProvider.inputPrice")}>
                  <Input
                    type="number"
                    min="0"
                    step="0.0001"
                    value={inputPrice}
                    onChange={(e) => setInputPrice(Number(e.target.value) || 0)}
                    className="rounded-xl"
                  />
                </Field>
                <Field label={t("addProvider.outputPrice")}>
                  <Input
                    type="number"
                    min="0"
                    step="0.0001"
                    value={outputPrice}
                    onChange={(e) => setOutputPrice(Number(e.target.value) || 0)}
                    className="rounded-xl"
                  />
                </Field>
                <WorkRoleSelector value={workRoles} onChange={setWorkRoles} />
              </>
            )}

            {error && <p className="text-xs text-red-500">{error}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving} className="rounded-xl">
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving} className="rounded-xl">
            {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label className="text-[10px] font-bold uppercase tracking-widest px-1">{label}</Label>
      {children}
    </div>
  );
}
