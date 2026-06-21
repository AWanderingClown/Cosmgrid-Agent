// AddProviderDialog - 添加供应商 + 凭证 + 模型
// v0.3：apiFetch → db.ts 直连 SQLite，API Key → keystore
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
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
import { type WorkRole } from "@/lib/api";
import { providers as dbProviders, apiCredentials as dbCredentials, models as dbModels } from "@/lib/db";
import { saveApiKey, deleteApiKey } from "@/lib/keystore";
import { inferModelCapabilities } from "@/lib/llm/model-capabilities";
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
  const [workRoles, setWorkRoles] = useState<WorkRole[]>(INITIAL_STATE.workRoles);
  // 用户是否手动改过角色——改过就不再被自动识别覆盖（尊重人工选择）
  const [rolesEditedManually, setRolesEditedManually] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        capabilityTags: JSON.stringify([]),
        capabilityScore: JSON.stringify(inferred.capabilityScore),
        workRoles: JSON.stringify(workRoles),
      });
      createdModelId = model.id;

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
          <ProviderTypeSelect
            value={providerType}
            onChange={(v) => {
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
            </>
          )}

          <ModelConfigFields
            modelName={modelName}
            displayName={displayName}
            contextWindow={contextWindow}
            onModelNameChange={handleModelNameChange}
            onDisplayNameChange={setDisplayName}
            onContextWindowChange={setContextWindow}
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
