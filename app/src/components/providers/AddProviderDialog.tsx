// AddProviderDialog - 添加供应商 + 凭证 + 模型
// v0.3：apiFetch → db.ts 直连 SQLite，API Key → keystore
import { useState } from "react";
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
};

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

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!providerName || !apiKey || !modelName || workRoles.length === 0) {
      setError("请填所有必填项");
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
        name: providerName + " 默认凭证",
        baseUrl,
        enabled: true,
        supportsStreaming: true,
        supportsFunctionCall: true,
        supportsVision: false,
      });
      createdCredentialId = credential.id;

      // 3. API Key 存 keystore（不入 DB）
      await saveApiKey(credential.id, apiKey);

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
      const message = err instanceof Error ? err.message : "添加失败";
      try {
        if (createdModelId) await dbModels.delete(createdModelId);
        if (createdCredentialId) {
          await dbCredentials.delete(createdCredentialId);
          await deleteApiKey(createdCredentialId);
        }
        if (createdProviderId) await dbProviders.delete(createdProviderId);
      } catch (rollbackErr) {
        console.error("[AddProviderDialog] 回滚失败:", rollbackErr);
      }
      setError(`${message}（已自动回滚）`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>添加供应商</DialogTitle>
          <DialogDescription>
            填一次，Provider + 凭证 + Model 一起建好
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

          <ModelConfigFields
            modelName={modelName}
            displayName={displayName}
            contextWindow={contextWindow}
            onModelNameChange={handleModelNameChange}
            onDisplayNameChange={setDisplayName}
            onContextWindowChange={setContextWindow}
          />

          <WorkRoleSelector value={workRoles} onChange={handleWorkRolesChange} />

          <TestConnectionButton
            providerType={providerType}
            modelName={modelName}
            apiKey={apiKey}
            baseUrl={baseUrl}
            disabled={submitting}
          />

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
              取消
            </Button>
            <Button
              type="submit"
              disabled={submitting || workRoles.length === 0}
            >
              {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {submitting ? "添加中..." : "添加"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
