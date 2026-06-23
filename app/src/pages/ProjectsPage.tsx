// ProjectsPage - 重构为 "Cosmic Cyber" 视觉风格
import { useEffect, useState } from "react";
import { ArrowRight, Check, FolderKanban, Plus, Trash2, Pencil, Calendar, Layout, MapPin, Activity } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BUILT_IN_TEMPLATES } from "@/lib/templates";
import { cn } from "@/lib/utils";

/** 内置模板 name → i18nKey 映射（给 ProjectsPage select 显示用） */
const BUILT_IN_TEMPLATE_NAME_TO_KEY: Record<string, "fullstack_web" | "data_science" | "mobile_app" | "small_script"> = Object.fromEntries(
  BUILT_IN_TEMPLATES.map((b) => [b.name, b.nameKey]),
) as Record<string, "fullstack_web" | "data_science" | "mobile_app" | "small_script">;
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  projects as dbProjects,
  projectTemplates as dbTemplates,
  type Project,
  type ProjectTemplate,
} from "@/lib/db";
import { useConfirm } from "@/components/ui/confirm-dialog";

const STATUS_KEYS = ["pending", "active", "paused", "completed", "failed"] as const;
const STATUS_COLORS: Record<typeof STATUS_KEYS[number], string> = {
  pending: "text-blue-400",
  active: "text-emerald-400",
  paused: "text-amber-400",
  completed: "text-indigo-400",
  failed: "text-red-400",
};

function formatTime(iso: string, locale: string): string {
  // i18n.language: "zh-CN" / "en-US" -> toLocaleDateString 接受 "zh-CN" / "en-US" 直接用
  return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export interface ProjectsPageProps {
  onOpenProject?: (id: string) => void;
}

export function ProjectsPage({ onOpenProject }: ProjectsPageProps = {}) {
  const { t, i18n } = useTranslation();
  const { confirm } = useConfirm();
  const [items, setItems] = useState<Project[]>([]);
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [templateId, setTemplateId] = useState<string>("");

  // 编辑项目（标题 + 描述）
  const [editing, setEditing] = useState<Project | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  async function load() {
    try {
      const [p, tpls] = await Promise.all([dbProjects.list(), dbTemplates.list()]);
      setItems(p);
      setTemplates(tpls);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("common.error"));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function openCreateDialog() {
    setStep(1);
    setName("");
    setDescription("");
    setWorkspacePath("");
    setTemplateId(templates[0]?.id ?? "");
    setDialogOpen(true);
  }

  async function createProject() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await dbProjects.create({
        name: name.trim(),
        description: description.trim() || null,
        templateId: templateId || null,
        workspacePath: workspacePath.trim() || null,
      });
      setDialogOpen(false);
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function deleteProject(id: string) {
    if (!(await confirm({ description: t("projects.deleteConfirm"), destructive: true }))) return;
    await dbProjects.delete(id);
    await load();
  }

  function openEditDialog(p: Project) {
    setEditing(p);
    setEditName(p.name);
    setEditDesc(p.description ?? "");
  }

  async function saveEdit() {
    if (!editing || !editName.trim()) return;
    setEditSaving(true);
    try {
      await dbProjects.update(editing.id, {
        name: editName.trim(),
        description: editDesc.trim() || null,
      });
      setEditing(null);
      await load();
    } finally {
      setEditSaving(false);
    }
  }

  const selectedTemplate = templates.find((tpl) => tpl.id === templateId) ?? null;

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
    <div className="h-full w-full overflow-y-auto p-8 bg-background/30 backdrop-blur-sm custom-scrollbar">
      <div className="space-y-10">
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-primary">
              <Activity className="w-5 h-5" />
              <span className="text-[10px] font-bold uppercase tracking-[0.2em]">{t("projects.sectionLabel")}</span>
            </div>
            <h1 className="text-4xl font-black tracking-tight">{t("projects.title")}</h1>
            <p className="text-muted-foreground text-sm max-w-xl">
              {t("projects.desc")}
            </p>
          </div>
          <Button
            onClick={openCreateDialog}
            className="rounded-2xl px-8 h-12 bg-primary shadow-xl shadow-primary/20 hover:scale-105 transition-all font-bold"
          >
            <Plus className="w-5 h-5 mr-2" />
            {t("projects.createButton")}
          </Button>
        </header>

        {items.length === 0 ? (
          <Card className="glass border-dashed p-20 text-center flex flex-col items-center gap-6 rounded-[2.5rem]">
            <div className="w-20 h-20 bg-muted/30 rounded-[2rem] flex items-center justify-center">
              <FolderKanban className="w-10 h-10 text-muted-foreground/20" />
            </div>
            <div className="space-y-2">
              <h3 className="text-xl font-bold">{t("projects.empty.title")}</h3>
              <p className="text-sm text-muted-foreground">{t("projects.empty.desc")}</p>
            </div>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {items.map((p) => {
              const statusKey = (STATUS_KEYS as readonly string[]).includes(p.status)
                ? (p.status as typeof STATUS_KEYS[number])
                : "pending";
              const statusColor = STATUS_COLORS[statusKey];
              return (
                <Card
                  key={p.id}
                  className={cn(
                    "group glass border-white/10 rounded-[2rem] p-0 overflow-hidden transition-all duration-500 hover:border-primary/30 hover:shadow-2xl hover:shadow-primary/5",
                    onOpenProject && "cursor-pointer"
                  )}
                  onClick={() => onOpenProject?.(p.id)}
                >
                  <div className="p-7 space-y-6">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1 flex-1 min-w-0 pr-4">
                        <div className="flex items-center gap-2">
                          <h2 className="text-xl font-bold tracking-tight truncate group-hover:text-primary transition-colors">{p.name}</h2>
                          <div className={cn("px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border border-current/20", statusColor, "bg-current/10")}>
                            {t(`projectStatus.${statusKey}`)}
                          </div>
                        </div>
                        <p className="text-sm text-muted-foreground/60 line-clamp-1">{p.description || t("projects.noDescription")}</p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="rounded-xl hover:bg-primary/10 hover:text-primary"
                          title={t("projects.editButton")}
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditDialog(p);
                          }}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="rounded-xl hover:bg-red-500/10 hover:text-red-500"
                          title={t("common.delete")}
                          onClick={(e) => {
                            e.stopPropagation();
                            void deleteProject(p.id);
                          }}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-white/5 rounded-2xl p-3 flex flex-col gap-1 border border-white/5">
                        <span className="text-[9px] font-bold text-muted-foreground/50 uppercase tracking-widest flex items-center gap-1.5">
                          <Layout className="w-3 h-3" /> {t("projects.currentStage")}
                        </span>
                        <span className="text-xs font-bold truncate">{p.currentStage || t("projects.initializing")}</span>
                      </div>
                      <div className="bg-white/5 rounded-2xl p-3 flex flex-col gap-1 border border-white/5">
                        <span className="text-[9px] font-bold text-muted-foreground/50 uppercase tracking-widest flex items-center gap-1.5">
                          <Activity className="w-3 h-3" /> {t("projects.template")}
                        </span>
                        <span className="text-xs font-bold truncate">{p.template?.name || t("projects.noTemplate")}</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-white/5">
                      <div className="flex items-center gap-1.5 text-muted-foreground/40 text-[10px] font-medium">
                        <Calendar className="w-3 h-3" />
                        {t("projects.updatedAt", { time: formatTime(p.updatedAt, i18n.language) })}
                      </div>
                      {p.workspacePath && (
                        <div className="flex items-center gap-1 text-[10px] text-primary/60 font-mono">
                          <MapPin className="w-3 h-3" />
                          {t("projects.pathConnected")}
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="glass border-white/10 rounded-[2.5rem] max-w-lg p-0 overflow-hidden">
          <DialogHeader className="p-8 pb-4">
            <div className="flex items-center gap-3 mb-2">
               <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <Plus className="w-5 h-5 text-primary" />
               </div>
               <div>
                  <DialogTitle className="text-xl font-bold tracking-tight">{t("projects.createDialog.title")}</DialogTitle>
                  <DialogDescription className="text-xs">{t("projects.createDialog.step", { current: step, total: 2 })}</DialogDescription>
               </div>
            </div>
            {/* 进度条 */}
            <div className="flex gap-2 mt-4">
              <div className={cn("h-1 flex-1 rounded-full transition-all duration-500", step >= 1 ? "bg-primary shadow-[0_0_8px_var(--primary)]" : "bg-white/10")} />
              <div className={cn("h-1 flex-1 rounded-full transition-all duration-500", step >= 2 ? "bg-primary shadow-[0_0_8px_var(--primary)]" : "bg-white/10")} />
            </div>
          </DialogHeader>

          <div className="p-8 pt-4 space-y-6">
            {step === 1 && (
              <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-500">
                <div className="space-y-2">
                  <Label className="text-[10px] font-bold uppercase tracking-widest px-1">{t("projects.createDialog.selectTemplate")}</Label>
                  <Select value={templateId} onValueChange={setTemplateId}>
                    <SelectTrigger className="rounded-xl border-white/10 bg-white/5 h-12">
                      <SelectValue placeholder={t("projects.createDialog.selectTemplatePlaceholder")} />
                    </SelectTrigger>
                    <SelectContent className="glass border-white/10 rounded-xl">
                      {templates.map((tpl) => (
                        <SelectItem key={tpl.id} value={tpl.id} className="rounded-lg">
                          {tpl.isBuiltIn && tpl.name
                            ? t(`builtinTemplates.${(BUILT_IN_TEMPLATE_NAME_TO_KEY[tpl.name] ?? "small_script")}.name`, { defaultValue: tpl.name })
                            : tpl.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedTemplate?.description && (
                    <div className="p-4 bg-primary/5 rounded-2xl border border-primary/10">
                      <p className="text-xs leading-relaxed text-muted-foreground/80">{selectedTemplate.description}</p>
                    </div>
                  )}
                  <div className="p-4 bg-muted/20 rounded-2xl border border-white/5 flex gap-3 items-start">
                    <Check className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                    <p className="text-[10px] text-muted-foreground/60 leading-normal">
                      {t("projects.createDialog.templateHint")}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-500">
                <div className="space-y-2">
                  <Label htmlFor="project-name" className="text-[10px] font-bold uppercase tracking-widest px-1">{t("projects.createDialog.nameLabel")}</Label>
                  <Input
                    id="project-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("projects.createDialog.namePlaceholder")}
                    className="rounded-xl border-white/10 bg-white/5 h-12"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="project-desc" className="text-[10px] font-bold uppercase tracking-widest px-1">{t("projects.createDialog.descLabel")}</Label>
                  <Input
                    id="project-desc"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t("projects.createDialog.descPlaceholder")}
                    className="rounded-xl border-white/10 bg-white/5 h-12"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="project-workspace" className="text-[10px] font-bold uppercase tracking-widest px-1">{t("projects.createDialog.workspaceLabel")}</Label>
                  <Input
                    id="project-workspace"
                    value={workspacePath}
                    onChange={(e) => setWorkspacePath(e.target.value)}
                    placeholder={t("projects.createDialog.workspacePlaceholder")}
                    className="rounded-xl border-white/10 bg-white/5 h-12 font-mono text-xs"
                  />
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="p-8 pt-0 gap-3">
            {step === 1 ? (
              <>
                <Button variant="ghost" onClick={() => setDialogOpen(false)} className="rounded-xl h-11 flex-1">
                  {t("common.cancel")}
                </Button>
                <Button onClick={() => setStep(2)} disabled={!templateId} className="rounded-xl h-11 flex-1 bg-primary">
                  {t("projects.createDialog.next")} <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setStep(1)} className="rounded-xl h-11 flex-1">
                  {t("projects.createDialog.back")}
                </Button>
                <Button onClick={() => void createProject()} disabled={saving || !name.trim()} className="rounded-xl h-11 flex-1 bg-primary">
                  {saving ? t("projects.createDialog.submitting") : t("projects.createDialog.submit")}
                  <Check className="w-4 h-4 ml-2" />
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑项目：标题 + 描述 */}
      <Dialog open={editing !== null} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent className="glass border-white/10 rounded-[2.5rem] max-w-lg p-0 overflow-hidden">
          <DialogHeader className="p-8 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                <Pencil className="w-5 h-5 text-primary" />
              </div>
              <div>
                <DialogTitle className="text-xl font-bold tracking-tight">{t("projects.editDialog.title")}</DialogTitle>
                <DialogDescription className="text-xs">{t("projects.editDialog.desc")}</DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="p-8 pt-2 space-y-5">
            <div className="space-y-2">
              <Label htmlFor="edit-project-name" className="text-[10px] font-bold uppercase tracking-widest px-1">{t("projects.createDialog.nameLabel")}</Label>
              <Input
                id="edit-project-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder={t("projects.createDialog.namePlaceholder")}
                className="rounded-xl border-white/10 bg-white/5 h-12"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-project-desc" className="text-[10px] font-bold uppercase tracking-widest px-1">{t("projects.createDialog.descLabel")}</Label>
              <Input
                id="edit-project-desc"
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder={t("projects.createDialog.descPlaceholder")}
                className="rounded-xl border-white/10 bg-white/5 h-12"
              />
            </div>
          </div>
          <DialogFooter className="p-8 pt-0 gap-3">
            <Button variant="ghost" onClick={() => setEditing(null)} className="rounded-xl h-11 flex-1">
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void saveEdit()} disabled={editSaving || !editName.trim()} className="rounded-xl h-11 flex-1 bg-primary">
              {editSaving ? t("projects.createDialog.submitting") : t("common.save")}
              <Check className="w-4 h-4 ml-2" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>

  );
}
