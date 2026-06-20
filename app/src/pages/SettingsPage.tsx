// SettingsPage - 设置页 (v0.7.5: 移除缺失的 RadioGroup 依赖，采用自定义稳定实现)
import { useState } from "react";
import { Settings, Moon, Sun, Languages, Monitor, ShieldCheck, Database, Info, Check } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [language, setLanguage] = useState("zh");

  const themes = [
    { id: "light", label: "浅色模式", icon: Sun },
    { id: "dark", label: "深色模式", icon: Moon },
    { id: "system", label: "跟随系统", icon: Monitor },
  ];

  return (
    <div className="h-full overflow-y-auto p-8 bg-background/30 backdrop-blur-sm custom-scrollbar">
      <div className="max-w-4xl mx-auto space-y-10 pb-20">
        <header className="space-y-3 border-l-4 border-primary pl-6 py-2">
          <div className="flex items-center gap-2 text-primary font-bold">
            <Settings className="w-5 h-5" />
            <span className="text-xs uppercase tracking-widest">系统设置</span>
          </div>
          <h1 className="text-4xl font-black tracking-tight dark:text-white">偏好设置</h1>
          <p className="text-muted-foreground dark:text-muted-foreground/80 text-sm max-w-2xl leading-relaxed">
            在此管理您的界面显示、语言习惯及底层核心配置。
          </p>
        </header>

        <div className="grid gap-6">
          {/* 外观设置 */}
          <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] p-8 space-y-8 shadow-xl">
            <div className="flex items-center gap-3 pb-4 border-b border-white/10">
              <Monitor className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-bold dark:text-white">外观与视觉</h2>
            </div>

            <div className="space-y-6">
              <div className="space-y-3">
                <Label className="text-sm font-bold opacity-60">显示主题</Label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {themes.map((t) => {
                    const Icon = t.icon;
                    const isActive = theme === t.id;
                    return (
                      <button
                        key={t.id}
                        onClick={() => setTheme(t.id as any)}
                        className={cn(
                          "group flex flex-col items-center justify-center rounded-2xl border-2 p-6 transition-all duration-300 relative overflow-hidden",
                          isActive
                            ? "border-primary bg-primary/5 text-primary shadow-lg shadow-primary/5"
                            : "border-muted bg-white/5 hover:border-white/20 text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {isActive && (
                          <div className="absolute top-2 right-2">
                            <Check className="w-4 h-4" />
                          </div>
                        )}
                        <Icon className={cn("mb-3 h-6 w-6 transition-transform group-hover:scale-110", isActive && "scale-110")} />
                        <span className="text-xs font-bold">{t.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="pt-4 space-y-3">
                <Label className="text-sm font-bold opacity-60">界面语言</Label>
                <Select value={language} onValueChange={setLanguage}>
                  <SelectTrigger className="w-full sm:w-72 rounded-xl border-white/10 bg-white/5 dark:bg-black/20 h-11 text-sm font-bold dark:text-white">
                    <div className="flex items-center gap-2">
                      <Languages className="w-4 h-4" />
                      <SelectValue placeholder="选择语言" />
                    </div>
                  </SelectTrigger>
                  <SelectContent className="glass border-white/10 rounded-xl">
                    <SelectItem value="zh" className="rounded-lg">简体中文</SelectItem>
                    <SelectItem value="en" className="rounded-lg">English (即将推出)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </Card>

          {/* 安全与数据 */}
          <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] p-8 space-y-8 shadow-xl">
            <div className="flex items-center gap-3 pb-4 border-b border-white/10">
              <ShieldCheck className="w-5 h-5 text-emerald-500" />
              <h2 className="text-xl font-bold dark:text-white">安全与本地数据</h2>
            </div>

            <div className="space-y-6">
              <div className="flex items-center justify-between gap-4 p-5 bg-white/5 rounded-2xl border border-white/5">
                <div className="space-y-1">
                  <div className="text-sm font-bold">本地数据库</div>
                  <p className="text-xs text-muted-foreground">所有的对话、API 凭证和项目数据均存储在本地 SQLite 数据库中。</p>
                </div>
                <Button variant="outline" size="sm" className="rounded-xl border-white/10 h-10 px-4">
                  <Database className="w-4 h-4 mr-2" />
                  管理数据库
                </Button>
              </div>

              <div className="flex items-center justify-between gap-4 p-5 bg-white/5 rounded-2xl border border-white/5">
                <div className="space-y-1">
                  <div className="text-sm font-bold">API 密钥存储</div>
                  <p className="text-xs text-muted-foreground">密钥通过操作系统的安全钥匙串进行加密存储，安全性由底层 OS 保障。</p>
                </div>
                <Badge className="bg-emerald-500/20 text-emerald-500 border-none px-3 py-1 font-bold">加密存储中</Badge>
              </div>
            </div>
          </Card>

          {/* 关于 */}
          <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] p-8 space-y-8 shadow-xl">
            <div className="flex items-center gap-3 pb-4 border-b border-white/10">
              <Info className="w-5 h-5 text-indigo-500" />
              <h2 className="text-xl font-bold dark:text-white">关于 CosmGrid</h2>
            </div>

            <div className="flex flex-col items-center text-center py-6 space-y-4">
              <div className="text-3xl font-black bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
                CosmGrid Agent
              </div>
              <div className="text-[10px] font-black text-muted-foreground/40 uppercase tracking-[0.4em]">
                Version 0.7.5 Stable
              </div>
              <p className="text-sm text-muted-foreground max-w-md leading-relaxed font-medium">
                下一代多 Agent 协作工作站，致力于为开发者提供最稳定、直观且高效的 AI 协作环境。
              </p>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
