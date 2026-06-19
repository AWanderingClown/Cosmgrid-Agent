// 基础字段（供应商名 / 备注 / 官网）
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
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-2">
        <Label htmlFor="providerName">
          供应商名称<span className="text-destructive ml-1">*</span>
        </Label>
        <Input
          id="providerName"
          value={providerName}
          onChange={(e) => onProviderNameChange(e.target.value)}
          placeholder="我的 Claude"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="website">官网</Label>
        <Input
          id="website"
          type="url"
          value={website}
          onChange={(e) => onWebsiteChange(e.target.value)}
          placeholder="https://anthropic.com"
        />
      </div>
      <div className="col-span-2 space-y-2">
        <Label htmlFor="notes">备注</Label>
        <Input
          id="notes"
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder="公司报销的 API Key"
        />
      </div>
    </div>
  );
}