// API Key 输入控件（带眼睛按钮显示/隐藏）
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

interface ApiKeyInputProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  required?: boolean;
  placeholder?: string;
}

export function ApiKeyInput({
  value,
  onChange,
  label,
  required = false,
  placeholder = "sk-...",
}: ApiKeyInputProps) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-2">
      <Label htmlFor="apikey">
        {label ?? t("addProvider.apiKey")}
        {required && <span className="text-destructive ml-1">*</span>}
      </Label>
      <div className="relative">
        <Input
          id="apikey"
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          className="pr-10 font-mono"
        />
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0 top-0 h-full px-3"
            onClick={() => setShow(!show)}
            aria-label={show ? t("addProvider.hide") : t("addProvider.show")}
          >
            {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </Button>
        )}
      </div>
    </div>
  );
}
