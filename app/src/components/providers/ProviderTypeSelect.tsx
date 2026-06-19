// Provider 类型下拉（anthropic / openai / google / openai-compatible）
// v0.2 仅支持 3 个原生 provider，v0.3 加 openai-compatible 接 GLM/DeepSeek/Qwen
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

export const PROVIDER_TYPES = [
  { value: "anthropic", label: "Anthropic（Claude）" },
  { value: "openai", label: "OpenAI（GPT）" },
  { value: "google", label: "Google（Gemini）" },
  { value: "openai-compatible", label: "OpenAI 兼容（GLM / DeepSeek / Qwen / 自定义）" },
] as const;

export type ProviderTypeValue = (typeof PROVIDER_TYPES)[number]["value"];

interface ProviderTypeSelectProps {
  value: string;
  onChange: (value: ProviderTypeValue) => void;
}

export function ProviderTypeSelect({ value, onChange }: ProviderTypeSelectProps) {
  return (
    <div className="space-y-2">
      <Label>Provider 类型</Label>
      <Select value={value} onValueChange={(v) => onChange(v as ProviderTypeValue)}>
        <SelectTrigger>
          <SelectValue placeholder="选择 Provider" />
        </SelectTrigger>
        <SelectContent>
          {PROVIDER_TYPES.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}