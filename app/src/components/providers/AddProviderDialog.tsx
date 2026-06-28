// AddProviderDialog - 添加供应商 + 凭证 + 模型
// v0.3：apiFetch → db.ts 直连 SQLite，API Key → keystore
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Download, ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { type WorkRole } from "@/lib/api";
import { providers as dbProviders, apiCredentials as dbCredentials, models as dbModels } from "@/lib/db";
import { saveApiKey, deleteApiKey } from "@/lib/keystore";
import { inferModelCapabilities } from "@/lib/llm/model-capabilities";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PROVIDER_PRESETS, type ProviderPreset } from "@/lib/llm/provider-presets";
import { fetchAvailableModels } from "@/lib/llm/fetch-models";
import { saveManualModelPrice } from "@/lib/llm/price-catalog";
import { ApiKeyInput } from "./ApiKeyInput";
import { ProviderTypeSelect, type ProviderTypeValue } from "./ProviderTypeSelect";
import { BasicFormFields } from "./BasicFormFields";
import { WorkRoleSelector } from "./WorkRoleSelector";
import { ModelConfigFields } from "./ModelConfigFields";
import { TestConnectionButton } from "./TestConnectionButton";

interface AddProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

const DEFAULT_BASE_URLS: Record<ProviderTypeValue, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  // openai-compatible 默认空，让用户在 BasicFormFields 自己填
  "openai-compatible": "",
  // CLI 引擎：baseUrl 复用为「可执行文件路径」，默认空＝用系统 PATH 里的 claude/codex
  "claude-cli": "",
  "codex-cli": "",
};

/** CLI 引擎类型：spawn 本机 CLI 吃订阅额度，不需要 API Key / URL 端点 */
function isCliType(type: ProviderTypeValue): boolean {
  return type === "claude-cli" || type === "codex-cli";
}

const INITIAL_STATE = {
  providerType: "anthropic" as ProviderTypeValue,
  providerName: "",
  website: "",
  notes: "",
  baseUrl: DEFAULT_BASE_URLS.anthropic,
  apiKey: "",
  modelName: "",
  displayName: "",
  contextWindow: 200_000,
  inputPrice: 0,
  outputPrice: 0,
  workRoles: ["main_chat"] as WorkRole[],
};

export function AddProviderDialog({ open, onOpenChange, onSuccess }: AddProviderDialogProps) {
  const { t } = useTranslation();
  const [providerType, setProviderType] = useState<ProviderTypeValue>(INITIAL_STATE.providerType);
  const [providerName, setProviderName] = useState(INITIAL_STATE.providerName);
  const [website, setWebsite] = useState(INITIAL_STATE.website);
  const [notes, setNotes] = useState(INITIAL_STATE.notes);
  const [baseUrl, setBaseUrl] = useState(INITIAL_STATE.baseUrl);
  const [apiKey, setApiKey] = useState(INITIAL_STATE.apiKey);
  const [modelName, setModelName] = useState(INITIAL_STATE.modelName);
  const [displayName, setDisplayName] = useState(INITIAL_STATE.displayName);
  const [contextWindow, setContextWindow] = useState(INITIAL_STATE.contextWindow);
  const [inputPrice, setInputPrice] = useState(INITIAL_STATE.inputPrice);
  const [outputPrice, setOutputPrice] = useState(INITIAL_STATE.outputPrice);
  const [workRoles, setWorkRoles] = useState<WorkRole[]>(INITIAL_STATE.workRoles);
  // 用户是否手动改过角色——改过就不再被自动识别覆盖（尊重人工选择）
  const [rolesEditedManually, setRolesEditedManually] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 厂商预设 + 拉取模型
  const [presetId, setPresetId] = useState<string | null>(null);
  const [apiKeyUrl, setApiKeyUrl] = useState<string | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // 选一个厂商预设：自动带出 type / 名称 / baseUrl / 官网 / 默认模型，用户只需粘 key
  function applyPreset(preset: ProviderPreset) {
    setPresetId(preset.id);
    setProviderType(preset.providerType);
    setProviderName(preset.name);
    setBaseUrl(preset.baseUrl);
    setWebsite(preset.website ?? "");
    setContextWindow(preset.defaultContextWindow);
    setApiKeyUrl(preset.apiKeyUrl ?? null);
    setFetchedModels([]);
    setFetchError(null);
    handleModelNameChange(preset.defaultModel);
  }

  // 粘 key 后拉取该厂商账号下真实可用的模型，避免手敲填错名字
  async function handleFetchModels() {
    setFetchingModels(true);
    setFetchError(null);
    setFetchedModels([]);
    try {
      const r = await fetchAvailableModels({ providerType, baseUrl, apiKey });
      if (r.ok) {
        setFetchedModels(r.models);
        // 若当前模型名不在真实列表里，自动选第一个真实模型，省得用户还得手动对
        if (!r.models.includes(modelName)) handleModelNameChange(r.models[0]!);
      } else {
        setFetchError(t(`addProvider.fetchModels.errors.${r.errorKey}`));
      }
    } catch {
      setFetchError(t("addProvider.fetchModels.errors.unknown"));
    } finally {
      setFetchingModels(false);
    }
  }

  // 填模型名时自动识别它适合的角色（用户没手动改过的前提下）
  function handleModelNameChange(name: string) {
    setModelName(name);
    if (!rolesEditedManually) {
      const inferred = name.trim() ? inferModelCapabilities(name).workRoles : INITIAL_STATE.workRoles;
      setWorkRoles(inferred);
    }
  }

  function handleWorkRolesChange(roles: WorkRole[]) {
    setRolesEditedManually(true);
    setWorkRoles(roles);
  }

  const isCli = isCliType(providerType);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // CLI 引擎不需要 API Key（走本机订阅登录态）
    if (!providerName || !modelName || workRoles.length === 0 || (!isCli && !apiKey)) {
      setError(t("addProvider.fillRequired"));
      return;
    }
    setSubmitting(true);
    setError(null);

    let createdProviderId: string | null = null;
    let createdCredentialId: string | null = null;
    let createdModelId: string | null = null;

    try {
      // 1. 建 Provider
      const provider = await dbProviders.create({
        name: providerName,
        type: providerType,
        website: website || null,
        notes: notes || null,
      });
      createdProviderId = provider.id;

      // 2. 建 ApiCredential（不存 API Key 到 DB）
      const credential = await dbCredentials.create({
        providerId: provider.id,
        name: `${providerName} Default Credential`,
        baseUrl,
        enabled: true,
        supportsStreaming: true,
        supportsFunctionCall: true,
        supportsVision: false,
      });
      createdCredentialId = credential.id;

      // 3. API Key 存 keystore（不入 DB）；CLI 引擎无 Key，跳过
      if (apiKey) await saveApiKey(credential.id, apiKey);

      // 4. 建 Model（capabilityScore 由模型名自动推断，模板页才能据此自动分配最优模型）
      const inferred = inferModelCapabilities(modelName);
      const model = await dbModels.create({
        providerId: provider.id,
        name: modelName,
        displayName: displayName || null,
        contextWindow,
        inputPrice: inputPrice > 0 ? inputPrice : null,
        outputPrice: outputPrice > 0 ? outputPrice : null,
        capabilityTags: JSON.stringify([]),
        capabilityScore: JSON.stringify(inferred.capabilityScore),
        workRoles: JSON.stringify(workRoles),
      });
      createdModelId = model.id;

      if (inputPrice > 0 && outputPrice > 0) {
        await saveManualModelPrice({
          modelName,
          providerType,
          inputPer1m: inputPrice,
          outputPer1m: outputPrice,
          contextWindow: contextWindow || null,
        });
      }

      // 5. 回填 defaultModelId
      await dbCredentials.update(credential.id, { defaultModelId: model.id });

      onSuccess?.();
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("addProvider.addFailed");
      try {
        if (createdModelId) await dbModels.delete(createdModelId);
        if (createdCredentialId) {
          await dbCredentials.delete(createdCredentialId);
          await deleteApiKey(createdCredentialId);
        }
        if (createdProviderId) await dbProviders.delete(createdProviderId);
      } catch (rollbackErr) {
        console.error("[AddProviderDialog] rollback failed:", rollbackErr);
      }
      setError(`${message} (${t("addProvider.rollbackFailed")})`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("addProvider.title")}</DialogTitle>
          <DialogDescription>
            {t("addProvider.desc")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* 厂商预设：点一下自动带出 类型/名称/Base URL/官网/默认模型，只需再粘 API Key。
              「自定义」清空回到手动；选了任何厂商都仍可手改下面每一项。 */}
          <div className="space-y-2">
            <Label>{t("addProvider.presetLabel")}</Label>
            <div className="flex flex-wrap gap-2">
              {PROVIDER_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className={cn(
                    "px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors",
                    presetId === p.id
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border hover:bg-muted",
                  )}
                >
                  {p.name}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setPresetId(null);
                  setApiKeyUrl(null);
                  setFetchedModels([]);
                  setFetchError(null);
                }}
                className={cn(
                  "px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors",
                  presetId === null ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-muted",
                )}
              >
                {t("addProvider.presetCustom")}
              </button>
            </div>
          </div>

          <ProviderTypeSelect
            value={providerType}
            onChange={(v) => {
              // 手动改协议类型 = 走自定义，清掉预设关联
              setPresetId(null);
              setApiKeyUrl(null);
              setProviderType(v);
              setBaseUrl(DEFAULT_BASE_URLS[v]);
            }}
          />

          <BasicFormFields
            providerName={providerName}
            notes={notes}
            website={website}
            onProviderNameChange={setProviderName}
            onNotesChange={setNotes}
            onWebsiteChange={setWebsite}
          />

          {isCli ? (
            <div className="space-y-2">
              <Label htmlFor="baseUrl">{t("addProvider.cliPathLabel")}</Label>
              <Input
                id="baseUrl"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={providerType === "claude-cli" ? "/usr/local/bin/claude" : "/usr/local/bin/codex"}
              />
              <p className="text-xs text-muted-foreground">{t("addProvider.cliHint")}</p>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="baseUrl">Base URL</Label>
                <Input
                  id="baseUrl"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </div>

              <ApiKeyInput
                value={apiKey}
                onChange={setApiKey}
                required
                placeholder="sk-ant-..."
              />
              {apiKeyUrl && (
                <button
                  type="button"
                  onClick={() => void openUrl(apiKeyUrl).catch(() => {})}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <ExternalLink className="w-3 h-3" />
                  {t("addProvider.getApiKey")}
                </button>
              )}
            </>
          )}

          {/* 拉取真实模型列表：粘 key 后点一下，从该厂商账号下真实可用模型里选，杜绝填错名字。
              对「所有」非 CLI 厂商都显示（含自定义）——这样不在预设里的任意 OpenAI 兼容厂商也能一键拉取。 */}
          {!isCli && (
            <div className="space-y-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleFetchModels()}
                disabled={fetchingModels || !apiKey || !baseUrl}
              >
                {fetchingModels ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
                {fetchingModels ? t("addProvider.fetchModels.loading") : t("addProvider.fetchModels.button")}
              </Button>
              {fetchedModels.length > 0 && (
                <div className="space-y-1">
                  <Label>{t("addProvider.fetchModels.pickLabel")}</Label>
                  <Select value={fetchedModels.includes(modelName) ? modelName : ""} onValueChange={handleModelNameChange}>
                    <SelectTrigger>
                      <SelectValue placeholder={t("addProvider.fetchModels.pickPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {fetchedModels.map((m) => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{t("addProvider.fetchModels.pickHint", { count: fetchedModels.length })}</p>
                </div>
              )}
              {fetchError && <p className="text-xs text-destructive">{fetchError}</p>}
            </div>
          )}

          <ModelConfigFields
            modelName={modelName}
            displayName={displayName}
            contextWindow={contextWindow}
            inputPrice={inputPrice}
            outputPrice={outputPrice}
            onModelNameChange={handleModelNameChange}
            onDisplayNameChange={setDisplayName}
            onContextWindowChange={setContextWindow}
            onInputPriceChange={setInputPrice}
            onOutputPriceChange={setOutputPrice}
          />

          <WorkRoleSelector value={workRoles} onChange={handleWorkRolesChange} />

          {!isCli && (
            <TestConnectionButton
              providerType={providerType}
              modelName={modelName}
              apiKey={apiKey}
              baseUrl={baseUrl}
              disabled={submitting}
            />
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={submitting || workRoles.length === 0}
            >
              {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {submitting ? t("addProvider.submitting") : t("addProvider.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
