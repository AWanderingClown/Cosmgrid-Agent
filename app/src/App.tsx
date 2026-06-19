// Cosmgrid-Agent 主入口
// v0.3：启动时调 initSchema() 建表（tauri-plugin-sql）
// v0.4.3：加全局 Token Plan 阈值告警条（60s 拉一次，超阈值显示在顶部）
import { useState, useEffect } from "react";
import { AlertTriangle, Bot, KeyRound, MessageSquare, LayoutTemplate, Coins, FolderKanban, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { initSchema, seedBuiltInTemplates, tokenPlans as dbTokenPlans, type TokenPlan } from "@/lib/db";
import { planUsageLevel, type UsageLevel } from "@/lib/llm/plan-thresholds";
import { cn } from "@/lib/utils";
import { ChatPage } from "@/pages/ChatPage";
import { ProvidersPage } from "@/pages/ProvidersPage";
import { TemplatesPage } from "@/pages/TemplatesPage";
import { TokenPlansPage } from "@/pages/TokenPlansPage";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";

type PageKey = "chat" | "providers" | "templates" | "tokenPlans" | "projects";

interface NavItem {
  key: PageKey;
  icon: React.ReactNode;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { key: "chat", icon: <MessageSquare className="w-4 h-4" />, label: "对话" },
  { key: "projects", icon: <FolderKanban className="w-4 h-4" />, label: "项目工作区" },
  { key: "providers", icon: <KeyRound className="w-4 h-4" />, label: "API 接入" },
  { key: "templates", icon: <LayoutTemplate className="w-4 h-4" />, label: "项目模板" },
  { key: "tokenPlans", icon: <Coins className="w-4 h-4" />, label: "Token Plan" },
];

function App() {
  const [page, setPage] = useState<PageKey>("chat");
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [plans, setPlans] = useState<TokenPlan[]>([]);
  // 用户主动关闭告警（不持久化，刷新后再次出现，避免"永远静音"）
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    void initSchema()
      .then(() => seedBuiltInTemplates())
      .then(() => setDbReady(true))
      .catch((err: unknown) => setDbError(err instanceof Error ? err.message : "数据库初始化失败"));
  }, []);

  // Token Plan 阈值监控：启动 + 每 60s 拉一次
  useEffect(() => {
    if (!dbReady) return;
    void dbTokenPlans.list().then(setPlans);
    const id = setInterval(() => {
      void dbTokenPlans.list().then(setPlans);
    }, 60_000);
    return () => clearInterval(id);
  }, [dbReady]);

  // 切换到 Token Plan 页时立即刷新一次（用户刚改完想看结果）
  useEffect(() => {
    if (page === "tokenPlans") {
      void dbTokenPlans.list().then((p) => {
        setPlans(p);
        setDismissedIds(new Set()); // 改了之后清掉静音
      });
    }
  }, [page]);

  const alerts = plans
    .map((p) => ({ plan: p, level: planUsageLevel(p) }))
    .filter((x) => x.level !== "ok")
    .filter((x) => !dismissedIds.has(x.plan.id));

  if (!dbReady) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-foreground">
        <p className="text-muted-foreground text-sm">
          {dbError ? `启动失败：${dbError}` : "初始化数据库…"}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* 侧栏 */}
      <aside className="w-56 border-r flex flex-col p-3 gap-1 bg-muted/30">
        <div className="px-2 py-3 mb-2">
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Bot className="w-5 h-5" />
            Cosmgrid-Agent
          </h1>
        </div>

        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => {
              setPage(item.key);
              if (item.key !== "projects") setOpenProjectId(null);
            }}
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors",
              page === item.key
                ? "bg-primary text-primary-foreground"
                : "hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {item.icon}
            {item.label}
          </button>
        ))}

        {/* v0.2.1 删除：硬编码版本号（v0.3 改读 package.json + Vite define）*/}
        {/* v0.2.1 删除：模型池 disabled 占位按钮（v0.3 实现 ModelsPage）*/}
      </aside>

      {/* 主区域 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 全局 Token Plan 阈值告警条（v0.4.3）—— 顶到最上、不挡 nav */}
        {alerts.length > 0 && (
          <div className="border-b bg-amber-50 dark:bg-amber-950/30 px-4 py-2 space-y-1">
            {alerts.map(({ plan, level }) => (
              <PlanAlertBar
                key={plan.id}
                level={level}
                planName={plan.name}
                providerName={plan.provider?.name}
                ratio={plan.totalQuota ? plan.usedQuota / plan.totalQuota : 0}
                onJump={() => setPage("tokenPlans")}
                onDismiss={() => setDismissedIds((prev) => new Set(prev).add(plan.id))}
              />
            ))}
          </div>
        )}

        {/* 用 display:none 保留 state（切换 Tab 不重 mount，避免 useChat 重置） */}
        <main className="flex-1 overflow-hidden">
          <div className="h-full" style={{ display: page === "chat" ? "block" : "none" }}>
            <ChatPage />
          </div>
          <div className="h-full" style={{ display: page === "providers" ? "block" : "none" }}>
            <ProvidersPage />
          </div>
          <div className="h-full" style={{ display: page === "templates" ? "block" : "none" }}>
            <TemplatesPage />
          </div>
          <div className="h-full" style={{ display: page === "tokenPlans" ? "block" : "none" }}>
            <TokenPlansPage />
          </div>
          <div className="h-full" style={{ display: page === "projects" ? "block" : "none" }}>
            {openProjectId ? (
              <ProjectDetailPage projectId={openProjectId} onBack={() => setOpenProjectId(null)} />
            ) : (
              <ProjectsPage onOpenProject={(id) => setOpenProjectId(id)} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

/** 告警条单元：套餐名 + 用量比例 + 文案 + 跳转/关闭按钮 */
function PlanAlertBar({
  level,
  planName,
  providerName,
  ratio,
  onJump,
  onDismiss,
}: {
  level: UsageLevel;
  planName: string;
  providerName: string | undefined;
  ratio: number;
  onJump: () => void;
  onDismiss: () => void;
}) {
  const isCritical = level === "exhausted" || level === "critical";
  const text = isCritical
    ? `套餐 ${planName}${providerName ? `（${providerName}）` : ""} 已用 ${(ratio * 100).toFixed(0)}%，建议切到 fallback 模型`
    : `套餐 ${planName}${providerName ? `（${providerName}）` : ""} 已用 ${(ratio * 100).toFixed(0)}%，接近耗尽`;

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 text-sm",
        isCritical ? "text-red-700 dark:text-red-300" : "text-amber-700 dark:text-amber-300",
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <span className="truncate">{text}</span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="ghost" onClick={onJump}>
          去查看
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss} title="关闭（下次用量上涨会重新出现）">
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

export default App;
