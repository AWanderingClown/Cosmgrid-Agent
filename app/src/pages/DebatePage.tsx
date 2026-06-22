// DebatePage - v0.8 阶段5：多角色对弈（Solver / Critic / Judge）
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Swords, Lightbulb, ShieldAlert, Gavel, Loader2, Zap, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { models as dbModels, apiCredentials as dbCredentials, debateSessions, type DebateRoundData } from "@/lib/db";
import { getApiKey } from "@/lib/keystore";

type ModelRow = Awaited<ReturnType<typeof dbModels.listEnabled>>[number];
type CredRow = Awaited<ReturnType<typeof dbCredentials.list>>[number];
import { pickBestModelForRole } from "@/lib/llm/model-capabilities";
import { isCliProviderType } from "@/lib/llm/cli-protocol";
import { runDebate, type DebateRoleConfig, type DebateRole } from "@/lib/llm/debate-engine";
import { realRunRole } from "@/lib/llm/debate-runner";

const ROLE_META: Record<DebateRole, { icon: typeof Lightbulb; color: string; workRole: string }> = {
  solver: { icon: Lightbulb, color: "text-blue-500", workRole: "planning" },
  critic: { icon: ShieldAlert, color: "text-amber-500", workRole: "review" },
  judge: { icon: Gavel, color: "text-emerald-500", workRole: "final_review" },
};

interface DebatePageProps {
  /** 从 ChatPage"开对弈"带过来的预填话题（上下文不丢：用户在对话里写的问题直接进对弈） */
  initialTopic?: string;
}

export function DebatePage({ initialTopic }: DebatePageProps = {}) {
  const { t } = useTranslation();
  const [models, setModels] = useState<ModelRow[]>([]);
  const [creds, setCreds] = useState<CredRow[]>([]);
  const [topic, setTopic] = useState("");
  const [quickMode, setQuickMode] = useState(false);
  const [running, setRunning] = useState(false);
  const [rounds, setRounds] = useState<DebateRoundData[]>([]);
  const [finalSolution, setFinalSolution] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof debateSessions.list>>>([]);

  // ChatPage 带话题跳转进来时预填（仅在 seed 变化时覆盖，不打扰用户已手输的内容）
  useEffect(() => {
    if (initialTopic && initialTopic.trim()) setTopic(initialTopic);
  }, [initialTopic]);

  useEffect(() => {
    void (async () => {
      const [m, c, h] = await Promise.all([
        dbModels.listEnabled(), dbCredentials.list(), debateSessions.list(20),
      ]);
      setModels(m);
      setCreds(c);
      setHistory(h);
    })();
  }, []);

  async function buildConfig(role: DebateRole): Promise<DebateRoleConfig | null> {
    const picked = pickBestModelForRole(ROLE_META[role].workRole, models) ?? pickBestModelForRole("main_chat", models);
    if (!picked) return null;
    const cred = creds.find((c) => c.providerId === picked.providerId);
    if (!cred) return null;
    const providerType = picked.provider?.type ?? "";
    const isCli = isCliProviderType(providerType);
    const apiKey = isCli ? "" : ((await getApiKey(cred.id)) ?? "");
    if (!isCli && !apiKey) return null;
    return {
      role,
      modelId: picked.id,
      modelName: picked.name,
      providerType,
      providerId: picked.providerId,
      apiCredentialId: cred.id,
      apiKey,
      ...(cred.baseUrl ? { baseUrl: cred.baseUrl } : {}),
    };
  }

  async function handleRun() {
    const tp = topic.trim();
    if (!tp || running) return;
    setRunning(true);
    setError(null);
    setRounds([]);
    setFinalSolution(null);
    try {
      const [solver, critic, judge] = await Promise.all([
        buildConfig("solver"), buildConfig("critic"), buildConfig("judge"),
      ]);
      if (!solver || !critic || !judge) {
        setError(t("debate.noModels"));
        return;
      }
      const result = await runDebate({ topic: tp, solver, critic, judge, quickMode }, realRunRole);
      setRounds(result.rounds);
      setFinalSolution(result.finalSolution);
      await debateSessions.create({
        topic: tp, quickMode, rounds: result.rounds, finalSolution: result.finalSolution,
      });
      setHistory(await debateSessions.list(20));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("debate.failed"));
    } finally {
      setRunning(false);
    }
  }

  async function loadHistory(id: string) {
    const s = await debateSessions.getById(id);
    if (s) {
      setTopic(s.topic);
      setQuickMode(s.quickMode);
      setRounds(s.rounds);
      setFinalSolution(s.finalSolution);
    }
  }

  async function deleteHistory(id: string) {
    await debateSessions.delete(id);
    setHistory(await debateSessions.list(20));
  }

  return (
    <div className="h-full w-full overflow-y-auto p-8 bg-background/30 backdrop-blur-sm custom-scrollbar">
      <div className="space-y-8 pb-20">
        <header className="space-y-3 border-l-4 border-primary pl-6 py-2">
          <div className="flex items-center gap-2 text-primary font-bold">
            <Swords className="w-5 h-5" />
            <span className="text-xs uppercase tracking-widest">{t("debate.sectionLabel")}</span>
          </div>
          <h1 className="text-4xl font-black tracking-tight dark:text-white">{t("debate.title")}</h1>
          <p className="text-muted-foreground dark:text-muted-foreground/80 text-sm max-w-2xl leading-relaxed">
            {t("debate.desc")}
          </p>
        </header>

        {/* 输入区 */}
        <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] p-6 space-y-4 shadow-xl">
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            disabled={running}
            placeholder={t("debate.topicPlaceholder")}
            className="w-full bg-white/5 dark:bg-black/20 border border-white/10 rounded-2xl px-5 py-4 text-sm outline-none focus:border-primary/40 resize-none h-24 dark:text-white"
          />
          <div className="flex items-center justify-between gap-4">
            <button
              type="button"
              onClick={() => setQuickMode((q) => !q)}
              disabled={running}
              className="flex items-center gap-2 text-xs font-bold text-muted-foreground hover:text-foreground transition-colors"
            >
              <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${quickMode ? "bg-amber-500" : "bg-white/15"}`}>
                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${quickMode ? "translate-x-5" : "translate-x-1"}`} />
              </span>
              {t("debate.quickMode")}
            </button>
            <Button onClick={() => void handleRun()} disabled={running || !topic.trim()} className="rounded-2xl h-11 px-6 font-bold">
              {running ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Swords className="w-4 h-4 mr-2" />}
              {running ? t("debate.running") : t("debate.start")}
            </Button>
          </div>
        </Card>

        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

        {/* 最终方案 */}
        {finalSolution && (
          <Card className="glass border-emerald-500/30 rounded-[2rem] p-7 shadow-xl space-y-3">
            <div className="flex items-center gap-2 text-emerald-500 font-bold">
              <Gavel className="w-5 h-5" />
              {t("debate.finalSolution")}
            </div>
            <div className="text-sm whitespace-pre-wrap leading-relaxed dark:text-white/90">{finalSolution}</div>
          </Card>
        )}

        {/* 三角色面板 */}
        {rounds.length > 0 && (
          <div className="grid gap-4">
            {rounds.map((r, i) => {
              const meta = ROLE_META[r.role];
              const Icon = meta.icon;
              return (
                <details key={i} className="glass border border-white/10 rounded-2xl overflow-hidden">
                  <summary className="flex items-center gap-3 px-5 py-3 cursor-pointer select-none">
                    <Icon className={`w-4 h-4 ${meta.color}`} />
                    <span className="font-bold text-sm">{t(`debate.role.${r.role}`)}</span>
                    <span className="text-[10px] font-mono text-muted-foreground truncate">{r.modelId}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {r.inputTokens + r.outputTokens} tok
                    </span>
                  </summary>
                  <div className="px-5 py-4 text-sm whitespace-pre-wrap leading-relaxed border-t border-white/10 dark:text-white/80">
                    {r.content}
                  </div>
                </details>
              );
            })}
          </div>
        )}

        {/* 历史 */}
        {history.length > 0 && (
          <div className="space-y-2 pt-4">
            <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              <Zap className="w-3.5 h-3.5" /> {t("debate.history")}
            </div>
            {history.map((h) => (
              <div key={h.id} className="flex items-center gap-3 p-3 bg-white/5 rounded-xl text-sm group">
                <button onClick={() => void loadHistory(h.id)} className="flex-1 text-left truncate hover:text-primary transition-colors">
                  {h.topic}
                </button>
                {h.quickMode && <span className="text-[9px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-500 font-bold">{t("debate.quickTag")}</span>}
                <button onClick={() => void deleteHistory(h.id)} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 transition-all">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
