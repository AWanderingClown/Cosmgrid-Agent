// TemplatesPage - 项目模板（7.8 / 4.13）
// 4 个内置模板（只定义角色清单）+ 用户自定义模板（复制内置 + 改模型分配 + 保存）
import { useEffect, useState } from "react";
import { LayoutTemplate, Copy, Trash2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  projectTemplates as dbTemplates,
  projectTemplateRoles as dbTemplateRoles,
  models as dbModels,
  type ProjectTemplate,
  type ProjectTemplateRole,
  type Model,
} from "@/lib/db";
import { BUILT_IN_TEMPLATES } from "@/lib/templates";
import { WORK_ROLES, parseWorkRoles } from "@/lib/api";
import { autoAssignModels } from "@/lib/llm/model-capabilities";

function roleLabel(role: string): string {
  return WORK_ROLES.find((r) => r.value === role)?.label ?? role;
}

export function TemplatesPage() {
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [roles, setRoles] = useState<ProjectTemplateRole[]>([]);
  const [saving, setSaving] = useState(false);

  async function load() {
    const [t, m] = await Promise.all([dbTemplates.list(), dbModels.listEnabled()]);
    setTemplates(t);
    setModels(m);
    if (!selectedId && t.length > 0) setSelectedId(t[0]!.id);
  }

  useEffect(() => {
    void load();
  }, []);

  // 选中模板（或模型列表就绪）时：加载已有分配，并给"还没分配模型的角色"自动配上最优模型。
  // 这样用户进来就看到默认值，不用一个个去选；想改再改。
  useEffect(() => {
    if (!selectedId) return;
    void loadRolesWithAutoAssign(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, models]);

  const selected = templates.find((t) => t.id === selectedId) ?? null;
  const builtInDef = selected ? BUILT_IN_TEMPLATES.find((b) => b.name === selected.name) : null;
  const roleNames = builtInDef ? builtInDef.workRoles : roles.map((r) => r.workRole);

  // 算出某模板的完整角色清单（内置模板看定义，自定义模板看已存的角色行）
  function roleNamesFor(templateId: string, existing: ProjectTemplateRole[]): string[] {
    const tpl = templates.find((t) => t.id === templateId);
    const def = tpl ? BUILT_IN_TEMPLATES.find((b) => b.name === tpl.name) : null;
    return def ? def.workRoles : existing.map((r) => r.workRole);
  }

  async function loadRolesWithAutoAssign(templateId: string) {
    const existing = await dbTemplateRoles.listByTemplate(templateId);
    const names = roleNamesFor(templateId, existing);
    const assigned = new Set(existing.map((r) => r.workRole));
    const unassigned = names.filter((n) => !assigned.has(n));

    if (unassigned.length > 0 && models.length > 0) {
      const map = autoAssignModels(unassigned, models);
      for (const [role, modelId] of map) {
        await dbTemplateRoles.create({ templateId, workRole: role, modelId });
      }
      setRoles(await dbTemplateRoles.listByTemplate(templateId));
    } else {
      setRoles(existing);
    }
  }

  // 一键智能分配：覆盖所有角色，重新按模型能力分配（用户手动改乱了想重置时用）
  async function autoAssignAll() {
    if (!selected || models.length === 0) return;
    setSaving(true);
    try {
      const map = autoAssignModels(roleNames, models);
      for (const role of roleNames) {
        const modelId = map.get(role);
        if (!modelId) continue;
        const existing = roleAssignment(role);
        if (existing) await dbTemplateRoles.update(existing.id, { modelId });
        else await dbTemplateRoles.create({ templateId: selected.id, workRole: role, modelId });
      }
      setRoles(await dbTemplateRoles.listByTemplate(selected.id));
    } finally {
      setSaving(false);
    }
  }

  function modelsForRole(role: string): Model[] {
    return models.filter((m) => parseWorkRoles(m.workRoles).includes(role) || parseWorkRoles(m.workRoles).length === 0);
  }

  function roleAssignment(role: string): ProjectTemplateRole | undefined {
    return roles.find((r) => r.workRole === role);
  }

  async function assignModel(role: string, modelId: string) {
    if (!selected) return;
    setSaving(true);
    try {
      const existing = roleAssignment(role);
      if (existing) {
        await dbTemplateRoles.update(existing.id, { modelId });
      } else {
        await dbTemplateRoles.create({ templateId: selected.id, workRole: role, modelId });
      }
      setRoles(await dbTemplateRoles.listByTemplate(selected.id));
    } finally {
      setSaving(false);
    }
  }

  async function assignFallback(role: string, fallbackModelId: string) {
    if (!selected) return;
    const existing = roleAssignment(role);
    if (!existing) return; // 主模型还没选，不能先选 fallback
    setSaving(true);
    try {
      await dbTemplateRoles.update(existing.id, { fallbackModelId: fallbackModelId || null });
      setRoles(await dbTemplateRoles.listByTemplate(selected.id));
    } finally {
      setSaving(false);
    }
  }

  async function saveAsCustom() {
    if (!selected) return;
    const name = prompt("新模板名称：", `${selected.name}（自定义）`);
    if (!name) return;
    const copy = await dbTemplates.create({ name, description: selected.description, icon: selected.icon, isBuiltIn: false });
    for (const role of roleNames) {
      const a = roleAssignment(role);
      if (a) {
        await dbTemplateRoles.create({
          templateId: copy.id,
          workRole: role,
          modelId: a.modelId,
          fallbackModelId: a.fallbackModelId,
        });
      }
    }
    await load();
    setSelectedId(copy.id);
  }

  async function deleteTemplate(id: string) {
    if (!confirm("确定删除这个自定义模板？")) return;
    await dbTemplates.delete(id);
    setSelectedId(null);
    await load();
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <LayoutTemplate className="w-5 h-5" />
          项目模板
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          每个模板定义"做这类项目时，每个角色用哪个模型"。添加模型后，系统会按模型擅长的领域自动分配，你只需在想调整时改。
        </p>
      </div>

      <div className="grid grid-cols-[240px_1fr] gap-4">
        <div className="space-y-2">
          {templates.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelectedId(t.id)}
              className={`w-full text-left p-3 rounded-lg border text-sm transition-colors ${
                selectedId === t.id ? "bg-primary text-primary-foreground" : "hover:bg-accent"
              }`}
            >
              <div className="font-medium flex items-center gap-2">
                {t.name}
                {t.isBuiltIn && <Badge variant="secondary" className="text-xs">内置</Badge>}
              </div>
            </button>
          ))}
        </div>

        {selected ? (
          <Card className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-semibold">{selected.name}</h2>
                <p className="text-xs text-muted-foreground mt-1">{selected.description}</p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void autoAssignAll()}
                  disabled={saving || models.length === 0}
                  title="按每个模型擅长的领域，自动给所有角色重新分配"
                >
                  <Sparkles className="w-3 h-3 mr-1" />
                  一键智能分配
                </Button>
                <Button variant="outline" size="sm" onClick={saveAsCustom}>
                  <Copy className="w-3 h-3 mr-1" />
                  另存为我的模板
                </Button>
                {!selected.isBuiltIn && (
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => deleteTemplate(selected.id)}>
                    <Trash2 className="w-3 h-3 mr-1" />
                    删除
                  </Button>
                )}
              </div>
            </div>

            {models.length === 0 && (
              <p className="text-sm text-amber-600">还没有可用模型，先去"API 接入"添加一个吧。</p>
            )}

            <div className="space-y-3">
              {roleNames.map((role) => {
                const a = roleAssignment(role);
                const candidates = modelsForRole(role);
                return (
                  <div key={role} className="flex items-center gap-3 bg-muted/30 rounded-lg p-3">
                    <Badge variant="outline" className="w-28 justify-center shrink-0">
                      {roleLabel(role)}
                    </Badge>
                    <Select
                      value={a?.modelId ?? ""}
                      onValueChange={(v) => void assignModel(role, v)}
                      disabled={saving}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="选择模型（首选）" />
                      </SelectTrigger>
                      <SelectContent>
                        {candidates.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.displayName ?? m.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={a?.fallbackModelId ?? ""}
                      onValueChange={(v) => void assignFallback(role, v)}
                      disabled={saving || !a}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="fallback（可选）" />
                      </SelectTrigger>
                      <SelectContent>
                        {candidates
                          .filter((m) => m.id !== a?.modelId)
                          .map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.displayName ?? m.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
          </Card>
        ) : (
          <Card className="p-12 text-center">
            <p className="text-muted-foreground">选一个模板看看</p>
          </Card>
        )}
      </div>
    </div>
  );
}
