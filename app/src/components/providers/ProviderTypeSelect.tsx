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

export const PROVIDER_TYPES = [
  { value: "anthropic", labelKey: "addProvider.providerTypes.anthropic" },
  { value: "openai", labelKey: "addProvider.providerTypes.openai" },
  { value: "google", labelKey: "addProvider.providerTypes.google" },
  { value: "openai-compatible", labelKey: "addProvider.providerTypes.openai-compatible" },
] as const;

export type ProviderTypeValue = (typeof PROVIDER_TYPES)[number]["value"];

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
