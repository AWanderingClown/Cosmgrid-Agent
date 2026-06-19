// ProjectsPage - 项目列表页（7.5 / 4.2 / 7.9）
// 创建项目（向导式）+ 状态机显示 + 删除
// v0.5：升级"新建项目"为 2 步向导（选模板 → 填信息），补 workspacePath 字段
// 模型分配由模板的 ProjectTemplateRole 决定（v0.3 起步已实现），这里不重复配置
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, FolderKanban, Plus, Trash2 } from "lucide-react";
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

const STATUS_LABEL: Record<string, string> = {
  pending: "待启动",
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  active: "default",
  paused: "secondary",
  completed: "secondary",
  failed: "destructive",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

export interface ProjectsPageProps {
  onOpenProject?: (id: string) => void;
}

export function ProjectsPage({ onOpenProject }: ProjectsPageProps = {}) {
  const [items, setItems] = useState<Project[]>([]);
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // 向导状态（v0.5）：2 步——选模板 → 填信息
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

  function closeDialog() {
    setDialogOpen(false);
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
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <FolderKanban className="w-5 h-5" />
            项目工作区
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            基于模板创建项目，多个 AI 协作完成一个编程项目。
          </p>
        </div>
        <Button onClick={openCreateDialog}>
          <Plus className="w-4 h-4 mr-1" />
          新建项目
        </Button>
      </div>

      {items.length === 0 ? (
        <Card className="p-12 text-center">
          <p className="text-muted-foreground">还没有项目，点右上角"新建项目"开始吧。</p>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {items.map((p) => (
            <Card
              key={p.id}
              className={cn(
                "p-4 space-y-2",
                onOpenProject && "cursor-pointer hover:bg-accent/40 transition-colors",
              )}
              onClick={() => onOpenProject?.(p.id)}
            >
              <div className="flex items-center justify-between">
                <h2 className="font-medium">{p.name}</h2>
                <div className="flex items-center gap-2">
                  <Badge variant={STATUS_VARIANT[p.status] ?? "outline"}>
                    {STATUS_LABEL[p.status] ?? p.status}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive h-7 w-7 p-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteProject(p.id);
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
              {p.description && (
                <p className="text-sm text-muted-foreground">{p.description}</p>
              )}
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>阶段：{p.currentStage}</span>
                {p.template?.name && <span>模板：{p.template.name}</span>}
                <span>更新于 {formatTime(p.updatedAt)}</span>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建项目（第 {step} / 2 步）</DialogTitle>
            <DialogDescription>
              {step === 1 ? "选个模板做起点" : "填项目基本信息"}
            </DialogDescription>
          </DialogHeader>

          {/* 进度条 */}
          <div className="flex gap-1.5">
            <div className={cn("h-1 flex-1 rounded-full", step >= 1 ? "bg-primary" : "bg-muted")} />
            <div className={cn("h-1 flex-1 rounded-full", step >= 2 ? "bg-primary" : "bg-muted")} />
          </div>

          {step === 1 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>项目模板</Label>
                <Select value={templateId} onValueChange={setTemplateId}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择模板" />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedTemplate?.description && (
                  <p className="text-xs text-muted-foreground">{selectedTemplate.description}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  模板里的角色→模型分配已经在「项目模板」页里配好了（零点击自动配 + 可手动改），新建项目时会按模板生成对应的阶段。
                </p>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="project-name">项目名称 *</Label>
                <Input
                  id="project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：电商网站后台"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="project-desc">描述（可选）</Label>
                <Input
                  id="project-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="简单说说这个项目做什么"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="project-workspace">工作空间路径（可选，以后可改）</Label>
                <Input
                  id="project-workspace"
                  value={workspacePath}
                  onChange={(e) => setWorkspacePath(e.target.value)}
                  placeholder="例如：~/projects/ecommerce-app"
                />
                <p className="text-xs text-muted-foreground">
                  这是项目在本机的路径，留空也可以（建完项目后再去详情页补）
                </p>
              </div>
              {selectedTemplate && (
                <div className="text-xs bg-muted/40 rounded-md p-2.5">
                  <span className="text-muted-foreground">将使用模板：</span>
                  <span className="font-medium">{selectedTemplate.name}</span>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            {step === 1 ? (
              <>
                <Button variant="outline" onClick={closeDialog}>
                  取消
                </Button>
                <Button onClick={() => setStep(2)} disabled={!templateId}>
                  下一步 <ArrowRight className="w-4 h-4 ml-1" />
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => setStep(1)}>
                  <ArrowLeft className="w-4 h-4 mr-1" /> 上一步
                </Button>
                <Button onClick={() => void createProject()} disabled={saving || !name.trim()}>
                  {saving ? "创建中…" : "创建项目"}
                  <Check className="w-4 h-4 ml-1" />
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
