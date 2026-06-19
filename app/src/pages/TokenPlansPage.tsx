// TokenPlansPage - Token Plan 管理（7.4 / 4.4）
// 管理订阅套餐的额度、恢复周期、阈值提醒（与 API 接入分离）
import { useEffect, useState } from "react";
import { Plus, Coins, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
  tokenPlans as dbTokenPlans,
  providers as dbProviders,
  type TokenPlan,
  type Provider,
} from "@/lib/db";

const PLAN_TYPES = [
  { value: "monthly", label: "月付" },
  { value: "usage", label: "按量" },
  { value: "message_count", label: "消息数" },
  { value: "token_pack", label: "Token 包" },
  { value: "time_window", label: "时间窗口恢复" },
  { value: "unknown", label: "未知" },
];

const QUOTA_UNITS = [
  { value: "token", label: "token" },
  { value: "request", label: "请求数" },
  { value: "message", label: "消息数" },
  { value: "usd", label: "美元" },
  { value: "time", label: "时间" },
];

function statusOf(p: TokenPlan): { label: string; variant: "default" | "secondary" | "destructive" | "outline" } {
  if (!p.totalQuota) return { label: "未知", variant: "outline" };
  const ratio = p.usedQuota / p.totalQuota;
  if (ratio >= 1) return { label: "已耗尽", variant: "destructive" };
  if (ratio >= 0.8) return { label: "接近耗尽", variant: "secondary" };
  return { label: "充足", variant: "default" };
}

export function TokenPlansPage() {
  const [plans, setPlans] = useState<TokenPlan[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({
    providerId: "",
    name: "",
    planType: "monthly",
    quotaUnit: "usd",
    totalQuota: "",
    resetRule: "",
  });

  async function load() {
    const [p, pr] = await Promise.all([dbTokenPlans.list(), dbProviders.list()]);
    setPlans(p);
    setProviders(pr);
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate() {
    if (!form.providerId || !form.name) {
      alert("请填写套餐名称并选择 Provider");
      return;
    }
    await dbTokenPlans.create({
      providerId: form.providerId,
      name: form.name,
      planType: form.planType,
      quotaUnit: form.quotaUnit,
      totalQuota: form.totalQuota ? Number(form.totalQuota) : null,
      resetRule: form.resetRule || null,
    });
    setDialogOpen(false);
    setForm({ providerId: "", name: "", planType: "monthly", quotaUnit: "usd", totalQuota: "", resetRule: "" });
    await load();
  }

  async function handleDelete(id: string) {
    if (!confirm("确定删除这个 Token Plan？")) return;
    await dbTokenPlans.delete(id);
    await load();
  }

  async function handleUsedQuotaChange(p: TokenPlan, value: string) {
    const usedQuota = Number(value);
    if (Number.isNaN(usedQuota)) return;
    await dbTokenPlans.update(p.id, { usedQuota });
    await load();
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Coins className="w-5 h-5" />
            Token Plan
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            管理订阅套餐额度，跟 API 接入分开（同一个 Provider 可以既有 API 又有套餐）
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)} disabled={providers.length === 0}>
          <Plus className="w-4 h-4 mr-2" />
          添加套餐
        </Button>
      </div>

      {providers.length === 0 && (
        <p className="text-sm text-amber-600">先去"API 接入"添加至少一个 Provider，才能挂套餐。</p>
      )}

      {plans.length === 0 ? (
        <Card className="p-12 text-center">
          <p className="text-muted-foreground">还没有添加任何 Token Plan</p>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {plans.map((p) => {
            const st = statusOf(p);
            const ratio = p.totalQuota ? Math.min(100, (p.usedQuota / p.totalQuota) * 100) : 0;
            return (
              <Card key={p.id} className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-medium">{p.name}</h3>
                    <p className="text-xs text-muted-foreground">{p.provider?.name}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={st.variant}>{st.label}</Badge>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(p.id)}>
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>

                {p.totalQuota != null && (
                  <div className="space-y-1">
                    <Progress value={ratio} />
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        已用 {p.usedQuota} / {p.totalQuota} {p.quotaUnit}
                      </span>
                      <Input
                        type="number"
                        defaultValue={p.usedQuota}
                        onBlur={(e) => void handleUsedQuotaChange(p, e.target.value)}
                        className="h-6 w-20 text-xs"
                      />
                    </div>
                  </div>
                )}

                <div className="flex gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">{PLAN_TYPES.find((t) => t.value === p.planType)?.label ?? p.planType}</Badge>
                  {p.resetRule && <Badge variant="outline">恢复：{p.resetRule}</Badge>}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加 Token Plan</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>所属 Provider</Label>
              <Select value={form.providerId} onValueChange={(v) => setForm({ ...form, providerId: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="选择 Provider" />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((pr) => (
                    <SelectItem key={pr.id} value={pr.id}>
                      {pr.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>套餐名称</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="如 Claude Code Max"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>套餐类型</Label>
                <Select value={form.planType} onValueChange={(v) => setForm({ ...form, planType: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLAN_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>额度单位</Label>
                <Select value={form.quotaUnit} onValueChange={(v) => setForm({ ...form, quotaUnit: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {QUOTA_UNITS.map((u) => (
                      <SelectItem key={u.value} value={u.value}>
                        {u.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>总额度（可空）</Label>
                <Input
                  type="number"
                  value={form.totalQuota}
                  onChange={(e) => setForm({ ...form, totalQuota: e.target.value })}
                  placeholder="如 100"
                />
              </div>
              <div>
                <Label>恢复周期（可空）</Label>
                <Input
                  value={form.resetRule}
                  onChange={(e) => setForm({ ...form, resetRule: e.target.value })}
                  placeholder="如 每月 1 日"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleCreate}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
