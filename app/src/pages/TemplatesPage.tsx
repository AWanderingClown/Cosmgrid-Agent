// TemplatesPage - 只保留默认角色体系；旧内置模板由 db.list() 隐藏，不删库。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LayoutTemplate, Plus, Settings2, ShieldAlert, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { autoAssignModels } from "@/lib/llm/model-capabilities";
import { ROLE_IDS, ROLE_TO_WORK_ROLE } from "@/lib/llm/orchestrator";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

export function TemplatesPage() {
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [roles, setRoles] = useState<ProjectTemplateRole[]>([]);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");

  async function load(nextSelectedId?: string | null) {
    try {
      const [tpls, m] = await Promise.all([dbTemplates.list(), dbModels.listEnabled()]);
      setTemplates(tpls);
      setModels(m);
      const validSelected = nextSelectedId ?? selectedId;
      if (validSelected && tpls.some((tpl) => tpl.id === validSelected)) {
        setSelectedId(validSelected);
      } else {
        setSelectedId(tpls[0]?.id ?? null);
      }
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("common.error"));
    }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!selectedId) {
      setRoles([]);
      return;
    }
    void loadRoles(selectedId);
  }, [selectedId]);

  const selected = templates.find((tpl) => tpl.id === selectedId) ?? null;

  async function loadRoles(templateId: string) {
    setRoles(await dbTemplateRoles.listByTemplate(templateId));
  }

  async function ensureEightRoleRows(templateId: string, sourceRows?: ProjectTemplateRole[]) {
    const existingRows = sourceRows ?? await dbTemplateRoles.listByTemplate(templateId);
    const existingByRole = new Map(existingRows.map((row) => [row.workRole, row]));

    for (let i = 0; i < ROLE_IDS.length; i++) {
      const role = ROLE_IDS[i]!;
      if (existingByRole.has(role)) continue;
      await dbTemplateRoles.create({
        templateId,
        workRole: role,
        modelId: "",
        fallbackModelId: null,
        order: i,
      });
    }
  }

  async function createTemplateFromDialog() {
    const name = templateName.trim();
    if (!name) return;
    setSaving(true);
    try {
      const tpl = await dbTemplates.create({
        name,
        description: "",
        icon: "Users",
        isBuiltIn: false,
        isDefault: false,
      });
      await ensureEightRoleRows(tpl.id, []);
      setCreateOpen(false);
      setTemplateName("");
      await load(tpl.id);
    } finally {
      setSaving(false);
    }
  }

  async function deleteSelectedTemplate() {
    if (!selected || selected.isBuiltIn) return;
    if (!(await confirm({ description: t("templates.deleteConfirm"), destructive: true }))) return;
    setSaving(true);
    try {
      await dbTemplates.delete(selected.id);
      await load(null);
    } finally {
      setSaving(false);
    }
  }

  async function autoAssignAll() {
    if (!selected || models.length === 0) return;
    setSaving(true);
    try {
      if (selected.isBuiltIn) await ensureEightRoleRows(selected.id, roles);
      const latestRows = await dbTemplateRoles.listByTemplate(selected.id);
      const targetRoles = selected.isBuiltIn
        ? [...ROLE_IDS]
        : latestRows
          .map((row) => row.workRole)
          .filter((role): role is (typeof ROLE_IDS)[number] => (ROLE_IDS as readonly string[]).includes(role));
      const map = autoAssignModels(targetRoles.map((role) => ROLE_TO_WORK_ROLE[role]), models);
      for (const role of targetRoles) {
        const modelId = map.get(ROLE_TO_WORK_ROLE[role]);
        if (!modelId) continue;
        const existing = latestRows.find((r) => r.workRole === role);
        if (existing) await dbTemplateRoles.update(existing.id, { modelId });
        else await dbTemplateRoles.create({ templateId: selected.id, workRole: role, modelId });
      }
      setRoles(await dbTemplateRoles.listByTemplate(selected.id));
    } finally {
      setSaving(false);
    }
  }

  async function addRole(role: string) {
    if (!selected || selected.isBuiltIn || !role) return;
    if (roleAssignment(role)) return;
    setSaving(true);
    try {
      const maxOrder = roles.reduce((max, row) => Math.max(max, row.order ?? 0), -1);
      await dbTemplateRoles.create({
        templateId: selected.id,
        workRole: role,
        modelId: "",
        fallbackModelId: null,
        order: maxOrder + 1,
      });
      setRoles(await dbTemplateRoles.listByTemplate(selected.id));
    } finally {
      setSaving(false);
    }
  }

  async function deleteRole(row: ProjectTemplateRole) {
    if (!selected || selected.isBuiltIn) return;
    setSaving(true);
    try {
      await dbTemplateRoles.delete(row.id);
      setRoles(await dbTemplateRoles.listByTemplate(selected.id));
    } finally {
      setSaving(false);
    }
  }

  function roleAssignment(role: string): ProjectTemplateRole | undefined {
    return roles.find((r) => r.workRole === role);
  }

  function displayTemplateName(tpl: ProjectTemplate): string {
    const def = BUILT_IN_TEMPLATES.find((b) => b.name === tpl.name);
    return def ? t(`builtinTemplates.${def.nameKey}.name`) : tpl.name;
  }

  async function assignModel(role: string, modelId: string) {
    if (!selected) return;
    setSaving(true);
    try {
      const existing = roleAssignment(role);
      if (existing) await dbTemplateRoles.update(existing.id, { modelId });
      else await dbTemplateRoles.create({ templateId: selected.id, workRole: role, modelId });
      setRoles(await dbTemplateRoles.listByTemplate(selected.id));
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <Alert variant="destructive" className="max-w-md bg-red-500/10 border-red-500/20 backdrop-blur-xl">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="app-page">
      <div className="app-section">
        <header className="app-page-header">
          <div className="app-eyebrow">
            <Settings2 className="w-4 h-4" />
            <span>{t("templates.sectionLabel")}</span>
          </div>
          <h1 className="app-page-title">{t("templates.title")}</h1>
          <p className="app-page-desc">
            {t("templates.desc")}
          </p>
        </header>

        <div className="flex flex-col xl:flex-row gap-6 items-start">
          <aside className="w-full xl:w-72 shrink-0 space-y-3">
            <div className="flex items-center justify-between px-4 mb-4">
              <div className="text-[10px] font-black text-muted-foreground/40 uppercase tracking-[0.2em]">{t("templates.available")}</div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  setTemplateName(t("templates.newTemplateDefaultName"));
                  setCreateOpen(true);
                }}
                className="h-8 w-8 rounded-xl bg-primary/10 text-primary hover:bg-primary hover:text-white"
                title={t("templates.addTemplate")}
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            {templates.map((tpl) => (
              <button
                key={tpl.id}
                onClick={() => setSelectedId(tpl.id)}
                className={cn(
                  "w-full text-left px-4 py-3.5 rounded-2xl border transition-all duration-300 group relative",
                  selectedId === tpl.id
                    ? "bg-primary text-primary-foreground border-transparent shadow-xl shadow-primary/20 translate-x-2"
                    : "glass border-white/10 hover:border-white/30 text-muted-foreground hover:text-foreground dark:bg-zinc-900/40",
                )}
              >
                <div className="space-y-1">
                  <div className="font-bold flex items-center justify-between gap-3">
                    <span className={cn("truncate", selectedId === tpl.id ? "text-white" : "text-foreground")}>
                      {displayTemplateName(tpl)}
                    </span>
                    {tpl.isBuiltIn && <Badge className="text-[9px] bg-white/20 text-white border-none">{t("templates.builtIn")}</Badge>}
                  </div>
                  <div className={cn("text-[10px] font-medium opacity-60", selectedId === tpl.id ? "text-white" : "")}>
                    {t("templates.rolesCount", { count: tpl.id === selectedId ? roles.length : ROLE_IDS.length })}
                  </div>
                </div>
              </button>
            ))}
          </aside>

          <div className="flex-1 min-w-0 w-full">
            {selected ? (
              <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] px-6 py-5 space-y-3 animate-in fade-in zoom-in-95 duration-500 shadow-2xl">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                  <div className="space-y-1">
                    <h2 className="text-[24px] leading-tight font-black tracking-tight dark:text-white">
                      {displayTemplateName(selected)}
                    </h2>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      onClick={() => void autoAssignAll()}
                      disabled={saving || models.length === 0}
                      className="rounded-xl h-10 px-4 text-xs font-bold bg-primary/10 text-primary hover:bg-primary hover:text-white transition-all gap-2"
                    >
                      <Sparkles className="w-4 h-4" /> {t("templates.smartAssign")}
                    </Button>
                    {!selected.isBuiltIn && (
                      <Button
                        variant="ghost"
                        onClick={() => void deleteSelectedTemplate()}
                        disabled={saving}
                        title={t("templates.deleteTemplate")}
                        className="rounded-xl h-10 w-10 p-0 bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white border border-red-500/10"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </div>

                {models.length === 0 && (
                  <div className="p-6 bg-amber-500/10 border border-amber-500/20 rounded-2xl flex items-center gap-4 text-amber-600 dark:text-amber-500">
                    <ShieldAlert className="w-6 h-6 shrink-0" />
                    <p className="text-sm font-bold">{t("templates.noModels")}</p>
                  </div>
                )}

                <div className="space-y-2.5">
                  {(selected.isBuiltIn
                    ? [...ROLE_IDS]
                    : roles
                      .map((row) => row.workRole)
                      .filter((role): role is (typeof ROLE_IDS)[number] => (ROLE_IDS as readonly string[]).includes(role))
                  ).map((role) => {
                    const a = roleAssignment(role);
                    return (
                      <div
                        key={role}
                        className="flex flex-col lg:flex-row lg:items-center gap-3 bg-white/5 dark:bg-zinc-900/30 border border-white/5 hover:border-primary/20 rounded-xl px-4 py-3 transition-all duration-300"
                      >
                        <div className="w-44 shrink-0">
                          <div className="text-sm font-black tracking-tight text-primary">
                            {t(`chat.orchestrator.roles.${role}`)}
                          </div>
                          <p className="text-[10px] text-muted-foreground/60 mt-0.5 font-bold tracking-wider">
                            {t(`templates.eightRole.${role}_desc`, { defaultValue: "" })}
                          </p>
                        </div>
                        <div className="flex-1 min-w-0 flex items-end gap-2">
                          <div className="flex-1 space-y-1">
                            <label className="text-[9px] font-black text-muted-foreground/40 uppercase px-1">
                              {t("templates.primaryModel")}
                            </label>
                            <Select
                              value={a?.modelId ?? ""}
                              onValueChange={(v) => void assignModel(role, v)}
                              disabled={saving}
                            >
                              <SelectTrigger className="rounded-lg border-white/10 bg-white/5 dark:bg-black/20 h-9 text-xs font-bold dark:text-white">
                                <SelectValue placeholder={t("templates.primaryModelPlaceholder")} />
                              </SelectTrigger>
                              <SelectContent className="glass border-white/10 rounded-xl">
                                {models.map((m) => (
                                  <SelectItem key={m.id} value={m.id} className="rounded-lg">
                                    {m.displayName ?? m.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          {!selected.isBuiltIn && a && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => void deleteRole(a)}
                              disabled={saving}
                              title={t("templates.deleteRole")}
                              className="h-9 w-9 rounded-lg text-muted-foreground/45 bg-muted/30 hover:bg-red-500/10 hover:text-red-500 border border-white/5 shrink-0"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {!selected.isBuiltIn && (
                    <div className="pt-1">
                      <Select onValueChange={(role) => void addRole(role)} disabled={saving || roles.length >= ROLE_IDS.length}>
                        <SelectTrigger className="w-full rounded-xl border-dashed border-primary/25 bg-primary/5 h-10 text-xs font-bold text-primary justify-center text-center [&>svg]:absolute [&>svg]:right-4">
                          <SelectValue placeholder={t("templates.addRole")} />
                        </SelectTrigger>
                        <SelectContent className="glass border-white/10 rounded-xl">
                          {ROLE_IDS
                            .filter((role) => !roleAssignment(role))
                            .map((role) => (
                              <SelectItem key={role} value={role} className="rounded-lg">
                                {t(`chat.orchestrator.roles.${role}`)}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              </Card>
            ) : (
              <div className="h-[500px] flex items-center justify-center glass rounded-[3rem] border-dashed">
                <div className="text-center space-y-4 opacity-30">
                  <div className="p-8 bg-primary/5 rounded-full w-fit mx-auto">
                    <LayoutTemplate className="w-16 h-16 text-primary" />
                  </div>
                  <p className="text-sm font-black uppercase tracking-[0.4em]">{t("templates.selectTemplateHint")}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="glass border-white/10 rounded-[2rem] max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold">{t("templates.addTemplate")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Label className="text-[10px] font-bold uppercase tracking-widest px-1">{t("templates.templateName")}</Label>
            <Input
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder={t("templates.templateNamePlaceholder")}
              className="rounded-xl border-white/10 bg-white/5 h-11"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} className="rounded-xl">
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void createTemplateFromDialog()} disabled={saving || !templateName.trim()} className="rounded-xl">
              {t("templates.createTemplate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
