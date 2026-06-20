// 基础字段（供应商名 / 备注 / 官网）
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface BasicFormFieldsProps {
  providerName: string;
  notes: string;
  website: string;
  onProviderNameChange: (v: string) => void;
  onNotesChange: (v: string) => void;
  onWebsiteChange: (v: string) => void;
}

export function BasicFormFields({
  providerName,
  notes,
  website,
  onProviderNameChange,
  onNotesChange,
  onWebsiteChange,
}: BasicFormFieldsProps) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-2">
        <Label htmlFor="providerName">
          {t("addProvider.providerName")}<span className="text-destructive ml-1">*</span>
        </Label>
        <Input
          id="providerName"
          value={providerName}
          onChange={(e) => onProviderNameChange(e.target.value)}
          placeholder={t("addProvider.providerNamePlaceholder")}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="website">{t("addProvider.website")}</Label>
        <Input
          id="website"
          type="url"
          value={website}
          onChange={(e) => onWebsiteChange(e.target.value)}
          placeholder="https://anthropic.com"
        />
      </div>
      <div className="col-span-2 space-y-2">
        <Label htmlFor="notes">{t("addProvider.notes")}</Label>
        <Input
          id="notes"
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder={t("addProvider.notesPlaceholder")}
        />
      </div>
    </div>
  );
}
