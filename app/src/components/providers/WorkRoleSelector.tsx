// 工作角色多选（8 个枚举值）
// v0.2.1 修复：用 lib/api.ts 的统一 WORK_ROLES（前后端一致）
// v0.3 评审建议改 Popover + cmdk 搜索，先用 checkbox grid（小白用户直观）
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { WORK_ROLES, type WorkRole } from "@/lib/api";

export { WORK_ROLES };
export type { WorkRole };

interface WorkRoleSelectorProps {
  value: WorkRole[];
  onChange: (roles: WorkRole[]) => void;
}

export function WorkRoleSelector({ value, onChange }: WorkRoleSelectorProps) {
  function toggle(role: WorkRole) {
    const next = value.includes(role) ? value.filter((r) => r !== role) : [...value, role];
    onChange(next);
  }

  return (
    <div className="space-y-3">
      <Label>
        工作角色<span className="text-destructive ml-1">*</span>
      </Label>
      <div className="grid grid-cols-2 gap-2">
        {WORK_ROLES.map((r) => (
          <label
            key={r.value}
            className="flex items-start gap-2 p-3 rounded-md border cursor-pointer hover:bg-accent transition-colors"
          >
            <Checkbox
              checked={value.includes(r.value)}
              onCheckedChange={() => toggle(r.value)}
              className="mt-0.5"
            />
            <div>
              <div className="text-sm font-medium">{r.label}</div>
              <div className="text-xs text-muted-foreground">{r.description}</div>
            </div>
          </label>
        ))}
      </div>
      {value.length === 0 && (
        <Alert variant="destructive">
          <AlertDescription>至少选择 1 个工作角色</AlertDescription>
        </Alert>
      )}
    </div>
  );
}