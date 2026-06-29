// SettingsPage - 设置页 (v0.7.5: 移除缺失的 RadioGroup 依赖，采用自定义稳定实现)
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Settings, Moon, Sun, Languages, Monitor, ShieldCheck, Database, Info, Check, Zap, FolderKanban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTheme, type Theme } from "@/lib/theme";
import { useSmartRoutingSetting } from "@/lib/app-settings";
import { SUPPORTED_LANGUAGES, LANGUAGE_LABELS, type SupportedLanguage } from "@/i18n";
import { cn } from "@/lib/utils";

export interface SettingsPageProps {
  onOpenProjectAssets?: () => void;
}

export function SettingsPage({ onOpenProjectAssets }: SettingsPageProps) {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [smartRouting, setSmartRouting] = useSmartRoutingSetting();
  const [language, setLanguageState] = useState<SupportedLanguage>(
    (SUPPORTED_LANGUAGES as readonly string[]).includes(i18n.language)
      ? (i18n.language as SupportedLanguage)
      : "zh-CN",
  );

  const themes: Array<{ id: Theme; label: string; icon: typeof Sun }> = [
    { id: "light", label: t("settings.appearance.themes.light"), icon: Sun },
    { id: "dark", label: t("settings.appearance.themes.dark"), icon: Moon },
    { id: "system", label: t("settings.appearance.themes.system"), icon: Monitor },
  ];

  function handleLanguageChange(value: string) {
    if (!(SUPPORTED_LANGUAGES as readonly string[]).includes(value)) return;
    const next = value as SupportedLanguage;
    setLanguageState(next);
    void i18n.changeLanguage(next);
  }

  return (
    <div className="h-full w-full overflow-y-auto p-8 bg-background/30 backdrop-blur-sm custom-scrollbar">
      <div className="space-y-10 pb-20">
        <header className="space-y-3 border-l-4 border-primary pl-6 py-2">
          <div className="flex items-center gap-2 text-primary font-bold">
            <Settings className="w-5 h-5" />
            <span className="text-xs uppercase tracking-widest">{t("settings.sectionLabel")}</span>
          </div>
          <h1 className="text-4xl font-black tracking-tight dark:text-white">{t("settings.title")}</h1>
          <p className="text-muted-foreground dark:text-muted-foreground/80 text-sm max-w-2xl leading-relaxed">
            {t("settings.desc")}
          </p>
        </header>

        <div className="grid gap-6">
          {/* 外观设置 */}
          <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] p-8 space-y-8 shadow-xl">
            <div className="flex items-center gap-3 pb-4 border-b border-white/10">
              <Monitor className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-bold dark:text-white">{t("settings.appearance.title")}</h2>
            </div>

            <div className="space-y-6">
              <div className="space-y-3">
                <Label className="text-sm font-bold opacity-60">{t("settings.appearance.theme")}</Label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {themes.map((th) => {
                    const Icon = th.icon;
                    const isActive = theme === th.id;
                    return (
                      <button
                        key={th.id}
                        onClick={() => setTheme(th.id)}
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
                        <span className="text-xs font-bold">{th.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="pt-4 space-y-3">
                <Label className="text-sm font-bold opacity-60">{t("settings.appearance.language")}</Label>
                <Select value={language} onValueChange={handleLanguageChange}>
                  <SelectTrigger className="w-full sm:w-72 rounded-xl border-white/10 bg-white/5 dark:bg-black/20 h-11 text-sm font-bold dark:text-white">
                    <div className="flex items-center gap-2">
                      <Languages className="w-4 h-4" />
                      <SelectValue placeholder={t("settings.appearance.languagePlaceholder")} />
                    </div>
                  </SelectTrigger>
                  <SelectContent className="glass border-white/10 rounded-xl">
                    {SUPPORTED_LANGUAGES.map((lng) => (
                      <SelectItem key={lng} value={lng} className="rounded-lg">
                        {LANGUAGE_LABELS[lng]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </Card>

          {/* 智能路由 v2 */}
          <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] p-8 space-y-8 shadow-xl">
            <div className="flex items-center gap-3 pb-4 border-b border-white/10">
              <Zap className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-bold dark:text-white">{t("settings.smartRouting.title")}</h2>
            </div>
            <div className="flex items-center justify-between gap-4 p-5 bg-white/5 rounded-2xl border border-white/5">
              <div className="space-y-1">
                <div className="text-sm font-bold">{t("settings.smartRouting.toggleTitle")}</div>
                <p className="text-xs text-muted-foreground max-w-lg leading-relaxed">{t("settings.smartRouting.toggleDesc")}</p>
              </div>
              <button
                role="switch"
                aria-checked={smartRouting}
                onClick={() => setSmartRouting(!smartRouting)}
                className={cn(
                  "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-300",
                  smartRouting ? "bg-primary" : "bg-white/15"
                )}
              >
                <span
                  className={cn(
                    "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-300",
                    smartRouting ? "translate-x-6" : "translate-x-1"
                  )}
                />
              </button>
            </div>
          </Card>

          {/* 安全与数据 */}
          <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] p-8 space-y-8 shadow-xl">
            <div className="flex items-center gap-3 pb-4 border-b border-white/10">
              <ShieldCheck className="w-5 h-5 text-emerald-500" />
              <h2 className="text-xl font-bold dark:text-white">{t("settings.security.title")}</h2>
            </div>

            <div className="space-y-6">
              <div className="flex items-center justify-between gap-4 p-5 bg-white/5 rounded-2xl border border-white/5">
                <div className="space-y-1 flex items-center gap-2">
                  <Database className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div>
                    <div className="text-sm font-bold">{t("settings.security.localDb.title")}</div>
                    <p className="text-xs text-muted-foreground">{t("settings.security.localDb.desc")}</p>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 p-5 bg-white/5 rounded-2xl border border-white/5">
                <div className="space-y-1">
                  <div className="text-sm font-bold">{t("settings.security.apiKey.title")}</div>
                  <p className="text-xs text-muted-foreground">{t("settings.security.apiKey.desc")}</p>
                </div>
                <Badge className="bg-primary/20 text-primary dark:text-primary border-none px-3 py-1 font-bold whitespace-nowrap">{t("settings.security.encrypted")}</Badge>
              </div>
            </div>
          </Card>

          {/* 项目资产（高级入口） */}
          <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] p-8 space-y-6 shadow-xl">
            <div className="flex items-center gap-3 pb-4 border-b border-white/10">
              <FolderKanban className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-bold dark:text-white">{t("settings.projectAssets.title")}</h2>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 bg-white/5 rounded-2xl border border-white/5">
              <div className="space-y-1">
                <div className="text-sm font-bold">{t("settings.projectAssets.entryTitle")}</div>
                <p className="text-xs text-muted-foreground max-w-xl leading-relaxed">{t("settings.projectAssets.entryDesc")}</p>
              </div>
              <Button
                type="button"
                onClick={onOpenProjectAssets}
                disabled={!onOpenProjectAssets}
                className="rounded-xl shrink-0"
              >
                {t("settings.projectAssets.open")}
              </Button>
            </div>
          </Card>

          {/* 关于 */}
          <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] p-8 space-y-8 shadow-xl">
            <div className="flex items-center gap-3 pb-4 border-b border-white/10">
              <Info className="w-5 h-5 text-indigo-500" />
              <h2 className="text-xl font-bold dark:text-white">{t("settings.about.title")}</h2>
            </div>

            <div className="flex flex-col items-center text-center py-6 space-y-4">
              <div className="text-3xl font-black bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
                CosmGrid Agent
              </div>
              <div className="text-[10px] font-black text-muted-foreground/40 uppercase tracking-[0.4em]">
                Version 0.7.5 Stable
              </div>
              <p className="text-sm text-muted-foreground max-w-md leading-relaxed font-medium">
                {t("settings.about.tagline")}
              </p>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
