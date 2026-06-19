// Model 配置字段（v0.2 每个 Provider 必须配 1 个 Model）
// 字段：model ID（API 用的名字）+ 显示名 + context window
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ModelConfigFieldsProps {
  modelName: string;
  displayName: string;
  contextWindow: number;
  onModelNameChange: (v: string) => void;
  onDisplayNameChange: (v: string) => void;
  onContextWindowChange: (v: number) => void;
}

export function ModelConfigFields({
  modelName,
  displayName,
  contextWindow,
  onModelNameChange,
  onDisplayNameChange,
  onContextWindowChange,
}: ModelConfigFieldsProps) {
  return (
    <div className="grid grid-cols-3 gap-4">
      <div className="space-y-2">
        <Label htmlFor="modelName">
          模型 ID<span className="text-destructive ml-1">*</span>
        </Label>
        <Input
          id="modelName"
          value={modelName}
          onChange={(e) => onModelNameChange(e.target.value)}
          placeholder="claude-sonnet-4-6"
          className="font-mono"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="displayName">显示名</Label>
        <Input
          id="displayName"
          value={displayName}
          onChange={(e) => onDisplayNameChange(e.target.value)}
          placeholder="Claude Sonnet 4.6"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="contextWindow">上下文窗口</Label>
        <Input
          id="contextWindow"
          type="number"
          value={contextWindow}
          onChange={(e) => onContextWindowChange(Number(e.target.value))}
          placeholder="200000"
        />
      </div>
    </div>
  );
}