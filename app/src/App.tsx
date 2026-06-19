// Cosmgrid-Agent 主入口
// v0.3：启动时调 initSchema() 建表（tauri-plugin-sql）
import { useState, useEffect } from "react";
import { initSchema, seedBuiltInTemplates } from "@/lib/db";
import { Bot, KeyRound, MessageSquare, LayoutTemplate, Coins, FolderKanban } from "lucide-react";
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

  useEffect(() => {
    void initSchema()
      .then(() => seedBuiltInTemplates())
      .then(() => setDbReady(true))
      .catch((err: unknown) => setDbError(err instanceof Error ? err.message : "数据库初始化失败"));
  }, []);

  function openProject(id: string) {
    setOpenProjectId(id);
  }

  function closeProject() {
    setOpenProjectId(null);
  }

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

      {/* 主区域：用 display:none 保留 state（切换 Tab 不重 mount，避免 useChat 重置） */}
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
            <ProjectDetailPage projectId={openProjectId} onBack={closeProject} />
          ) : (
            <ProjectsPage onOpenProject={openProject} />
          )}
        </div>
      </main>
    </div>
  );
}

export default App;