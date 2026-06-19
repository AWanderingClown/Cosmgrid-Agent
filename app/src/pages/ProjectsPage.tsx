// ProjectsPage - 项目列表页（7.5 / 4.2）
// 创建项目（选模板）、显示状态机（pending/active/paused/completed/failed）、删除项目
import { useEffect, useState } from "react";
import { FolderKanban, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
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
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [templateId, setTemplateId] = useState<string>("");
  const [saving, setSaving] = useState(false);

  async function load() {
    const [p, t] = await Promise.all([dbProjects.list(), dbTemplates.list()]);
    setItems(p);
    setTemplates(t);
  }

  useEffect(() => {
    void load();
  }, []);

  function openCreateDialog() {
    setName("");
    setDescription("");
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
            <DialogTitle>新建项目</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="project-name">项目名称</Label>
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
              <Label>项目模板</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger>
                  <SelectValue placeholder="选择模板（可选）" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void createProject()} disabled={saving || !name.trim()}>
              {saving ? "创建中…" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
