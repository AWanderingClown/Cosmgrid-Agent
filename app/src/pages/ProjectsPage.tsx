// ProjectsPage - 重构为 "Cosmic Cyber" 视觉风格
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, FolderKanban, Plus, Trash2, Calendar, Layout, MapPin, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: "待启动", color: "text-blue-400", bg: "bg-blue-400/10" },
  active: { label: "进行中", color: "text-emerald-400", bg: "bg-emerald-400/10" },
  paused: { label: "已暂停", color: "text-amber-400", bg: "bg-amber-400/10" },
  completed: { label: "已归档", color: "text-indigo-400", bg: "bg-indigo-400/10" },
  failed: { label: "失败", color: "text-red-400", bg: "bg-red-400/10" },
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleDateString("zh-CN", { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export interface ProjectsPageProps {
  onOpenProject?: (id: string) => void;
}

export function ProjectsPage({ onOpenProject }: ProjectsPageProps = {}) {
  const [items, setItems] = useState<Project[]>([]);
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [templateId, setTemplateId] = useState<string>("");

  async function load() {
    const [p, t] = await Promise.all([dbProjects.list(), dbTemplates.list()]);
    setItems(p);
    setTemplates(t);
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
    if (!confirm("确定删除这个项目？已记录的阶段历史也会一起删除。")) return;
    await dbProjects.delete(id);
    await load();
  }

  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;

  return (
    <div className="h-full overflow-y-auto p-8 bg-background/30 backdrop-blur-sm custom-scrollbar">
      <div className="max-w-6xl mx-auto space-y-10">
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-primary">
              <Activity className="w-5 h-5" />
              <span className="text-[10px] font-bold uppercase tracking-[0.2em]">活跃项目管理中心</span>
            </div>
            <h1 className="text-4xl font-black tracking-tight">项目工作区</h1>
            <p className="text-muted-foreground text-sm max-w-xl">
              管理多 Agent 协作项目。基于工业级工作流模板，让 AI 团队自动化完成复杂的开发、审计与部署任务。
            </p>
          </div>
          <Button
            onClick={openCreateDialog}
            className="rounded-2xl px-8 h-12 bg-primary shadow-xl shadow-primary/20 hover:scale-105 transition-all font-bold"
          >
            <Plus className="w-5 h-5 mr-2" />
            新建项目
          </Button>
        </header>

        {items.length === 0 ? (
          <Card className="glass border-dashed p-20 text-center flex flex-col items-center gap-6 rounded-[2.5rem]">
            <div className="w-20 h-20 bg-muted/30 rounded-[2rem] flex items-center justify-center">
              <FolderKanban className="w-10 h-10 text-muted-foreground/20" />
            </div>
            <div className="space-y-2">
              <h3 className="text-xl font-bold">空空如也</h3>
              <p className="text-sm text-muted-foreground">创建一个新项目，启动你的第一个 AI 自动化流水线。</p>
            </div>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {items.map((p) => {
              const status = STATUS_CONFIG[p.status] || STATUS_CONFIG.pending;
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
                          <div className={cn("px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border border-current/20", status.color, status.bg)}>
                            {status.label}
                          </div>
                        </div>
                        <p className="text-sm text-muted-foreground/60 line-clamp-1">{p.description || "未提供项目描述"}</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="rounded-xl hover:bg-red-500/10 hover:text-red-500 shrink-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteProject(p.id);
                        }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-white/5 rounded-2xl p-3 flex flex-col gap-1 border border-white/5">
                        <span className="text-[9px] font-bold text-muted-foreground/50 uppercase tracking-widest flex items-center gap-1.5">
                          <Layout className="w-3 h-3" /> 当前阶段
                        </span>
                        <span className="text-xs font-bold truncate">{p.currentStage || "初始化"}</span>
                      </div>
                      <div className="bg-white/5 rounded-2xl p-3 flex flex-col gap-1 border border-white/5">
                        <span className="text-[9px] font-bold text-muted-foreground/50 uppercase tracking-widest flex items-center gap-1.5">
                          <Activity className="w-3 h-3" /> 使用模板
                        </span>
                        <span className="text-xs font-bold truncate">{p.template?.name || "无"}</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-white/5">
                      <div className="flex items-center gap-1.5 text-muted-foreground/40 text-[10px] font-medium">
                        <Calendar className="w-3 h-3" />
                        最近更新于 {formatTime(p.updatedAt)}
                      </div>
                      {p.workspacePath && (
                        <div className="flex items-center gap-1 text-[10px] text-primary/60 font-mono">
                          <MapPin className="w-3 h-3" />
                          路径已连接
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
                  <DialogTitle className="text-xl font-bold tracking-tight">新建项目</DialogTitle>
                  <DialogDescription className="text-xs">第 {step} 步（共 2 步）</DialogDescription>
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
                  <Label className="text-[10px] font-bold uppercase tracking-widest px-1">核心流水线模板</Label>
                  <Select value={templateId} onValueChange={setTemplateId}>
                    <SelectTrigger className="rounded-xl border-white/10 bg-white/5 h-12">
                      <SelectValue placeholder="选择模板" />
                    </SelectTrigger>
                    <SelectContent className="glass border-white/10 rounded-xl">
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={t.id} className="rounded-lg">{t.name}</SelectItem>
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
                      系统将根据模板预定义的角色与工作阶段，自动为你分配合适的 AI 智能体组合。
                    </p>
                  </div>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-500">
                <div className="space-y-2">
                  <Label htmlFor="project-name" className="text-[10px] font-bold uppercase tracking-widest px-1">项目标识 *</Label>
                  <Input
                    id="project-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="输入具有识别性的项目名称"
                    className="rounded-xl border-white/10 bg-white/5 h-12"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="project-desc" className="text-[10px] font-bold uppercase tracking-widest px-1">项目简述</Label>
                  <Input
                    id="project-desc"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="可选，简单描述核心目标"
                    className="rounded-xl border-white/10 bg-white/5 h-12"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="project-workspace" className="text-[10px] font-bold uppercase tracking-widest px-1">物理路径 (工作区)</Label>
                  <Input
                    id="project-workspace"
                    value={workspacePath}
                    onChange={(e) => setWorkspacePath(e.target.value)}
                    placeholder="例如：~/developer/cosmgrid-project"
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
                  取消
                </Button>
                <Button onClick={() => setStep(2)} disabled={!templateId} className="rounded-xl h-11 flex-1 bg-primary">
                  下一步 <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setStep(1)} className="rounded-xl h-11 flex-1">
                  上一步
                </Button>
                <Button onClick={() => void createProject()} disabled={saving || !name.trim()} className="rounded-xl h-11 flex-1 bg-primary">
                  {saving ? "正在连接网络…" : "立即启动"}
                  <Check className="w-4 h-4 ml-2" />
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>

  );
}
