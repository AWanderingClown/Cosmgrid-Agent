// Provider 类型下拉（anthropic / openai / google / openai-compatible）
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { PROVIDER_TYPE_VALUES, type ProviderTypeValue } from "@/lib/llm/provider-presets";

export type { ProviderTypeValue };

const PROVIDER_TYPES = PROVIDER_TYPE_VALUES.map((value) => ({
  value,
  labelKey: `addProvider.providerTypes.${value}`,
}));

interface ProviderTypeSelectProps {
  value: string;
  onChange: (value: ProviderTypeValue) => void;
}

export function ProviderTypeSelect({ value, onChange }: ProviderTypeSelectProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <Label>{t("addProvider.providerType")}</Label>
      <Select value={value} onValueChange={(v) => onChange(v as ProviderTypeValue)}>
        <SelectTrigger>
          <SelectValue placeholder={t("addProvider.providerTypePlaceholder")} />
        </SelectTrigger>
        <SelectContent>
          {PROVIDER_TYPES.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {t(p.labelKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
