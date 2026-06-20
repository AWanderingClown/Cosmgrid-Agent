// TemplatesPage - 重构 v0.7.3: 彻底解决重叠，统一中文语言
import { useEffect, useState } from "react";
import { LayoutTemplate, Copy, Trash2, Sparkles, ChevronRight, Settings2, ShieldAlert } from "lucide-react";
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
import { cn } from "@/lib/utils";

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

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!selectedId) return;
    void loadRolesWithAutoAssign(selectedId);
  }, [selectedId, models]);

  const selected = templates.find((t) => t.id === selectedId) ?? null;
  const builtInDef = selected ? BUILT_IN_TEMPLATES.find((b) => b.name === selected.name) : null;
  const roleNames = builtInDef ? builtInDef.workRoles : roles.map((r) => r.workRole);

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
    } finally { setSaving(false); }
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
      if (existing) await dbTemplateRoles.update(existing.id, { modelId });
      else await dbTemplateRoles.create({ templateId: selected.id, workRole: role, modelId });
      setRoles(await dbTemplateRoles.listByTemplate(selected.id));
    } finally { setSaving(false); }
  }

  async function assignFallback(role: string, fallbackModelId: string) {
    if (!selected) return;
    const existing = roleAssignment(role);
    if (!existing) return;
    setSaving(true);
    try {
      await dbTemplateRoles.update(existing.id, { fallbackModelId: fallbackModelId || null });
      setRoles(await dbTemplateRoles.listByTemplate(selected.id));
    } finally { setSaving(false); }
  }

  return (
    <div className="h-full overflow-y-auto p-8 bg-background/30 backdrop-blur-sm custom-scrollbar">
      <div className="max-w-6xl mx-auto space-y-10 pb-20">
        <header className="space-y-3 border-l-4 border-primary pl-6 py-2">
          <div className="flex items-center gap-2 text-primary font-bold">
            <Settings2 className="w-5 h-5" />
            <span className="text-xs uppercase tracking-widest">流水线配置架构师</span>
          </div>
          <h1 className="text-4xl font-black tracking-tight dark:text-white">项目角色模板</h1>
          <p className="text-muted-foreground dark:text-muted-foreground/80 text-sm max-w-2xl leading-relaxed">
            定义不同协作场景下的 AI 专家组合。系统会自动根据各个模型的评分，为您推荐最擅长该领域的 AI 节点。
          </p>
        </header>

        <div className="flex flex-col xl:flex-row gap-8 items-start">
          {/* 左侧：模板选择列表 */}
          <aside className="w-full xl:w-72 shrink-0 space-y-3">
            <div className="text-[10px] font-black text-muted-foreground/40 uppercase tracking-[0.2em] px-4 mb-4">可用方案库</div>
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={cn(
                  "w-full text-left p-5 rounded-2xl border transition-all duration-300 group relative",
                  selectedId === t.id
                    ? "bg-primary text-primary-foreground border-transparent shadow-xl shadow-primary/20 translate-x-2"
                    : "glass border-white/10 hover:border-white/30 text-muted-foreground hover:text-foreground dark:bg-zinc-900/40"
                )}
              >
                <div className="space-y-1">
                  <div className="font-bold flex items-center justify-between">
                    <span className={cn(selectedId === t.id ? "text-white" : "text-foreground")}>{t.name}</span>
                    {t.isBuiltIn && <Badge className="text-[9px] bg-white/20 text-white border-none">内置</Badge>}
                  </div>
                  <div className={cn("text-[10px] font-medium opacity-60", selectedId === t.id ? "text-white" : "")}>
                    共包含 {BUILT_IN_TEMPLATES.find(b => b.name === t.name)?.workRoles.length || roles.length} 个协作节点
                  </div>
                </div>
              </button>
            ))}
          </aside>

          {/* 右侧：映射配置详情 */}
          <div className="flex-1 min-w-0 w-full">
            {selected ? (
              <Card className="glass border-white/15 dark:border-white/5 rounded-[2.5rem] p-8 space-y-8 animate-in fade-in zoom-in-95 duration-500 shadow-2xl">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6 pb-6 border-b border-white/10">
                  <div className="space-y-1">
                    <h2 className="text-2xl font-black tracking-tight dark:text-white">{selected.name}</h2>
                    <p className="text-sm font-medium text-muted-foreground">{selected.description || "正在为您加载该协作流程的专家配置清单。"}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      onClick={() => void autoAssignAll()}
                      disabled={saving || models.length === 0}
                      className="rounded-xl h-10 px-4 text-xs font-bold bg-primary/10 text-primary hover:bg-primary hover:text-white transition-all gap-2"
                    >
                      <Sparkles className="w-4 h-4" /> 智能一键分配
                    </Button>
                    <Button variant="ghost" className="rounded-xl h-10 px-4 text-xs font-bold bg-white/5 hover:bg-white/10 border border-white/5 gap-2 dark:text-white">
                      <Copy className="w-4 h-4" /> 另存模板
                    </Button>
                  </div>
                </div>

                {models.length === 0 && (
                  <div className="p-6 bg-amber-500/10 border border-amber-500/20 rounded-2xl flex items-center gap-4 text-amber-600 dark:text-amber-500">
                    <ShieldAlert className="w-6 h-6 shrink-0" />
                    <p className="text-sm font-bold">未检测到已连接的 AI 模型。请先前往「模型供应商」页面添加配置。</p>
                  </div>
                )}

                <div className="space-y-4">
                  {roleNames.map((role) => {
                    const a = roleAssignment(role);
                    const candidates = modelsForRole(role);
                    return (
                      <div key={role} className="flex flex-col lg:flex-row lg:items-center gap-6 bg-white/5 dark:bg-zinc-900/30 border border-white/5 hover:border-primary/20 rounded-2xl p-6 transition-all duration-300">
                        <div className="w-40 shrink-0">
                           <div className="text-sm font-black tracking-tight text-primary">{roleLabel(role)}</div>
                           <p className="text-[10px] text-muted-foreground/60 mt-1 uppercase font-bold tracking-wider">节点专家角色</p>
                        </div>

                        <ChevronRight className="hidden lg:block w-4 h-4 text-muted-foreground/20" />

                        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <label className="text-[10px] font-black text-muted-foreground/40 uppercase px-1">首选专家模型</label>
                            <Select
                              value={a?.modelId ?? ""}
                              onValueChange={(v) => void assignModel(role, v)}
                              disabled={saving}
                            >
                              <SelectTrigger className="rounded-xl border-white/10 bg-white/5 dark:bg-black/20 h-11 text-xs font-bold dark:text-white">
                                <SelectValue placeholder="请选择主模型" />
                              </SelectTrigger>
                              <SelectContent className="glass border-white/10 rounded-xl">
                                {candidates.map((m) => (
                                  <SelectItem key={m.id} value={m.id} className="rounded-lg">{m.displayName ?? m.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="space-y-2">
                            <label className="text-[10px] font-black text-muted-foreground/40 uppercase px-1">故障自动切换 (Fallback)</label>
                            <Select
                              value={a?.fallbackModelId ?? ""}
                              onValueChange={(v) => void assignFallback(role, v)}
                              disabled={saving || !a}
                            >
                              <SelectTrigger className="rounded-xl border-white/10 bg-white/5 dark:bg-black/20 h-11 text-xs font-bold dark:text-white">
                                <SelectValue placeholder="无备用方案" />
                              </SelectTrigger>
                              <SelectContent className="glass border-white/10 rounded-xl">
                                <SelectItem value="none" className="rounded-lg italic opacity-60">不启用备用方案</SelectItem>
                                {candidates.filter((m) => m.id !== a?.modelId).map((m) => (
                                  <SelectItem key={m.id} value={m.id} className="rounded-lg">{m.displayName ?? m.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            ) : (
              <div className="h-[500px] flex items-center justify-center glass rounded-[3rem] border-dashed">
                <div className="text-center space-y-4 opacity-30">
                   <div className="p-8 bg-primary/5 rounded-full w-fit mx-auto">
                     <LayoutTemplate className="w-16 h-16 text-primary" />
                   </div>
                   <p className="text-sm font-black uppercase tracking-[0.4em]">请从左侧选择一个方案模版</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
