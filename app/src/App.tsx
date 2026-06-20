// Cosmgrid-Agent 主入口
// v0.7.2: 彻底修复响应式布局冲突，回归稳定的 Flex 布局
import { useState, useEffect } from "react";
import { AlertTriangle, KeyRound, MessageSquare, LayoutTemplate, Coins, FolderKanban, X, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  initSchema,
  seedBuiltInTemplates,
  tokenPlans as dbTokenPlans,
  apiCredentials as dbCredentials,
  type TokenPlan,
} from "@/lib/db";
import { planUsageLevel, type UsageLevel } from "@/lib/llm/plan-thresholds";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";
import cosmgridLogo from "@/assets/cosmgrid-logo.svg";
import { ChatPage } from "@/pages/ChatPage";
import { ProvidersPage } from "@/pages/ProvidersPage";
import { TemplatesPage } from "@/pages/TemplatesPage";
import { TokenPlansPage } from "@/pages/TokenPlansPage";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";
import { OnboardingModal } from "@/pages/OnboardingModal";
import { SettingsPage } from "@/pages/SettingsPage";

type PageKey = "chat" | "providers" | "templates" | "tokenPlans" | "projects" | "settings";

interface NavItem {
  key: PageKey;
  icon: React.ReactNode;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { key: "chat", icon: <MessageSquare className="w-4 h-4" />, label: "智能对话" },
  { key: "projects", icon: <FolderKanban className="w-4 h-4" />, label: "项目工作区" },
  { key: "providers", icon: <KeyRound className="w-4 h-4" />, label: "模型供应商" },
  { key: "templates", icon: <LayoutTemplate className="w-4 h-4" />, label: "角色模板" },
  { key: "tokenPlans", icon: <Coins className="w-4 h-4" />, label: "用量监控" },
];

function App() {
  const [page, setPage] = useState<PageKey>("chat");
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [plans, setPlans] = useState<TokenPlan[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [providerCount, setProviderCount] = useState(0);

  useTheme();

  useEffect(() => {
    void initSchema()
      .then(() => seedBuiltInTemplates())
      .then(() => setDbReady(true))
      .catch((err: unknown) => setDbError(err instanceof Error ? err.message : "数据库初始化失败"));
  }, []);

  useEffect(() => {
    if (!dbReady) return;
    void dbCredentials.list().then((c) => setProviderCount(c.length));
  }, [dbReady]);

  useEffect(() => {
    if (page === "providers") {
      void dbCredentials.list().then((c) => setProviderCount(c.length));
    }
  }, [page]);

  useEffect(() => {
    if (!dbReady) return;
    void dbTokenPlans.list().then(setPlans);
    const id = setInterval(() => {
      void dbTokenPlans.list().then(setPlans);
    }, 60_000);
    return () => clearInterval(id);
  }, [dbReady]);

  useEffect(() => {
    if (page === "tokenPlans") {
      void dbTokenPlans.list().then((p) => {
        setPlans(p);
        setDismissedIds(new Set());
      });
    }
  }, [page]);

  const alerts = plans
    .map((p) => ({ plan: p, level: planUsageLevel(p) }))
    .filter((x) => x.level !== "ok")
    .filter((x) => !dismissedIds.has(x.plan.id));

  if (!dbReady) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="logo-wrap w-20 h-20 animate-pulse">
            <img src={cosmgridLogo} className="logo-base" alt="CosmGrid" />
          </div>
          <p className="text-sm font-bold tracking-widest text-primary uppercase">正在初始化核心组件...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      <OnboardingModal
        providerCount={providerCount}
        onNavigate={(p) => setPage(p)}
      />

      {/* Sidebar - Fixed Width, no-shrink */}
      <aside className="w-72 glass border-r flex flex-col p-6 gap-2 shrink-0">
        <div className="flex flex-col items-center py-10 mb-6 gap-4">
          <div className="logo-wrap w-24 h-24" aria-label="CosmGrid" role="img">
            <img src={cosmgridLogo} className="logo-base" alt="CosmGrid" />
          </div>
          <div className="text-center">
            <h1 className="text-xl font-bold bg-gradient-to-br from-primary to-accent bg-clip-text text-transparent">
              CosmGrid Agent
            </h1>
            <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground font-bold mt-1">智能核心管理层</p>
          </div>
        </div>

        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                setPage(item.key);
                if (item.key !== "projects") setOpenProjectId(null);
              }}
              className={cn(
                "flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-bold transition-all",
                page === item.key
                  ? "nav-item-active"
                  : "hover:bg-white/10 dark:hover:bg-white/5 text-muted-foreground hover:text-foreground",
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

        <div className="mt-auto pt-4 border-t border-white/5">
          <button
            type="button"
            onClick={() => setPage("settings")}
            className={cn(
              "w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-bold transition-all",
              page === "settings"
                ? "nav-item-active"
                : "hover:bg-white/10 dark:hover:bg-white/5 text-muted-foreground hover:text-foreground",
            )}
          >
            <Settings className="w-4 h-4" />
            <span>设置</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area - Fluid, handle overflow */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {/* Alerts - Floating */}
        {alerts.length > 0 && (
          <div className="absolute top-4 left-4 right-4 z-50">
            <div className="glass bg-accent/10 border-accent/20 rounded-2xl p-1 shadow-2xl">
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
          </div>
        )}

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
          <div className="h-full" style={{ display: page === "settings" ? "block" : "none" }}>
            <SettingsPage />
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
  const percentage = (ratio * 100).toFixed(0);

  return (
    <div className={cn("flex items-center justify-between gap-4 px-4 py-2 rounded-xl text-xs", isCritical ? "text-red-500" : "text-amber-500")}>
      <div className="flex items-center gap-2 truncate">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <span className="truncate font-bold uppercase">{planName} ({percentage}%)</span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="ghost" onClick={onJump} className="h-7 px-3 text-[10px] font-bold uppercase">前往处理</Button>
        <Button size="sm" variant="ghost" onClick={onDismiss} className="h-7 w-7 p-0"><X className="w-4 h-4" /></Button>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      onClick={toggleTheme}
      className="w-full flex items-center justify-between px-4 py-2 rounded-xl glass hover:bg-white/10 transition-all text-xs font-bold uppercase tracking-widest text-muted-foreground"
    >
      <div className="flex items-center gap-2">
        {isDark ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
        <span>{isDark ? "Midnight" : "Daylight"}</span>
      </div>
      <div className="w-8 h-4 bg-muted rounded-full relative">
        <div className={cn("absolute top-1 w-2 h-2 rounded-full transition-all", isDark ? "right-1 bg-primary" : "left-1 bg-muted-foreground")} />
      </div>
    </button>
  );
}

export default App;
