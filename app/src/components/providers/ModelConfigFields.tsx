// Model 配置字段（v0.2 每个 Provider 必须配 1 个 Model）
// 字段：model ID（API 用的名字）+ 显示名 + context window
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ModelConfigFieldsProps {
  modelName: string;
  displayName: string;
  contextWindow: number;
  inputPrice: number;
  outputPrice: number;
  onModelNameChange: (v: string) => void;
  onDisplayNameChange: (v: string) => void;
  onContextWindowChange: (v: number) => void;
  onInputPriceChange: (v: number) => void;
  onOutputPriceChange: (v: number) => void;
}

export function ModelConfigFields({
  modelName,
  displayName,
  contextWindow,
  inputPrice,
  outputPrice,
  onModelNameChange,
  onDisplayNameChange,
  onContextWindowChange,
  onInputPriceChange,
  onOutputPriceChange,
}: ModelConfigFieldsProps) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
      <div className="space-y-2">
        <Label htmlFor="modelName">
          {t("addProvider.modelId")}<span className="text-destructive ml-1">*</span>
        </Label>
        <Input
          id="modelName"
          value={modelName}
          onChange={(e) => onModelNameChange(e.target.value)}
          placeholder={t("addProvider.modelIdPlaceholder")}
          className="font-mono"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="displayName">{t("addProvider.displayName")}</Label>
        <Input
          id="displayName"
          value={displayName}
          onChange={(e) => onDisplayNameChange(e.target.value)}
          placeholder={t("addProvider.displayNamePlaceholder")}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="contextWindow">{t("addProvider.contextWindow")}</Label>
        <Input
          id="contextWindow"
          type="number"
          value={contextWindow}
          onChange={(e) => onContextWindowChange(Number(e.target.value))}
          placeholder="200000"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="inputPrice">{t("addProvider.inputPrice")}</Label>
        <Input
          id="inputPrice"
          type="number"
          min="0"
          step="0.0001"
          value={inputPrice}
          onChange={(e) => onInputPriceChange(Number(e.target.value) || 0)}
          placeholder="0"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="outputPrice">{t("addProvider.outputPrice")}</Label>
        <Input
          id="outputPrice"
          type="number"
          min="0"
          step="0.0001"
          value={outputPrice}
          onChange={(e) => onOutputPriceChange(Number(e.target.value) || 0)}
          placeholder="0"
        />
      </div>
    </div>
  );
}
