import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Code2, FileText, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { ResizeHandle, usePanelResize } from "@/components/ui/resize-handle";
import type { WorkArtifact } from "@/lib/work-artifacts";
import { FileTree } from "./FileTree";
import { loadFileContent, resolveWorkspaceFilePath } from "./file-source";
import { TabBar } from "./TabBar";
import { detectLanguage, type FileTab } from "./types";

const CodeEditor = lazy(() => import("./CodeEditor").then((m) => ({ default: m.CodeEditor })));

function isFileArtifact(artifact: WorkArtifact): boolean {
  return artifact.kind === "file" || artifact.kind === "html";
}

function makeTab(args: {
  filePath: string;
  displayPath?: string;
  content: string;
  source: FileTab["source"];
  isStreaming?: boolean;
  streamedLines?: number;
  totalLines?: number;
  error?: string;
}): FileTab {
  const totalLines = args.totalLines ?? Math.max(1, args.content.split("\n").length);
  return {
    filePath: args.filePath,
    displayPath: args.displayPath ?? args.filePath,
    content: args.content,
    language: detectLanguage(args.filePath),
    source: args.source,
    isStreaming: args.isStreaming ?? false,
    streamedLines: args.streamedLines ?? totalLines,
    totalLines,
    updatedAt: Date.now(),
    error: args.error,
  };
}

export function WorkPanelIde({ resetKey, workspacePath, artifacts, activeLabel, running }: {
  resetKey: string;
  workspacePath?: string | null;
  artifacts: WorkArtifact[];
  activeLabel: string;
  running: boolean;
}) {
  const { t } = useTranslation();
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activePath, setActivePath] = useState<string | undefined>();
  const streamedArtifactIdsRef = useRef(new Set<string>());
  const timersRef = useRef(new Map<string, number>());
  const fileTreePanel = usePanelResize({ initial: 176, min: 112, max: 320, edge: "right" });
  const activeTab = tabs.find((tab) => tab.filePath === activePath);

  const latestFileArtifact = useMemo(() => {
    return [...artifacts].reverse().find((artifact) => isFileArtifact(artifact) && artifact.status === "success");
  }, [artifacts]);

  useEffect(() => {
    timersRef.current.forEach((timer) => window.clearInterval(timer));
    timersRef.current.clear();
    streamedArtifactIdsRef.current.clear();
    setTabs([]);
    setActivePath(undefined);
  }, [resetKey]);

  const closeTab = useCallback((filePath: string) => {
    const timer = timersRef.current.get(filePath);
    if (timer) window.clearInterval(timer);
    timersRef.current.delete(filePath);
    setTabs((prev) => {
      const next = prev.filter((tab) => tab.filePath !== filePath);
      if (activePath === filePath) setActivePath(next[next.length - 1]?.filePath);
      return next;
    });
  }, [activePath]);

  const openFile = useCallback(async (filePath: string, opts: { artifactContent?: string; preferDisk?: boolean; stream?: boolean; artifactId?: string } = {}) => {
    const resolved = resolveWorkspaceFilePath(workspacePath, filePath);
    const displayPath = filePath.startsWith("/") && workspacePath && filePath.startsWith(workspacePath)
      ? filePath.slice(workspacePath.length + 1)
      : filePath;

    if (opts.stream && opts.artifactContent !== undefined) {
      const lines = opts.artifactContent.split("\n");
      const totalLines = Math.max(1, lines.length);
      const existingTimer = timersRef.current.get(resolved);
      if (existingTimer) window.clearInterval(existingTimer);
      setTabs((prev) => {
        const nextTab = makeTab({
          filePath: resolved,
          displayPath,
          content: "",
          source: "artifact",
          isStreaming: true,
          streamedLines: 0,
          totalLines,
        });
        const exists = prev.some((tab) => tab.filePath === resolved);
        return exists ? prev.map((tab) => (tab.filePath === resolved ? nextTab : tab)) : [...prev, nextTab];
      });
      setActivePath(resolved);
      let index = 0;
      const timer = window.setInterval(async () => {
        index += 1;
        const partial = lines.slice(0, index).join("\n");
        setTabs((prev) => prev.map((tab) => (
          tab.filePath === resolved
            ? { ...tab, content: partial, streamedLines: Math.min(index, totalLines), updatedAt: Date.now() }
            : tab
        )));
        if (index >= totalLines) {
          window.clearInterval(timer);
          timersRef.current.delete(resolved);
          const loaded = await loadFileContent({
            workspacePath,
            filePath,
            artifactContent: opts.artifactContent,
            preferDisk: opts.preferDisk,
          });
          setTabs((prev) => prev.map((tab) => (
            tab.filePath === resolved
              ? { ...tab, content: loaded.content, source: loaded.source, isStreaming: false, streamedLines: totalLines, error: loaded.error, updatedAt: Date.now() }
              : tab
          )));
        }
      }, 50);
      timersRef.current.set(resolved, timer);
      if (opts.artifactId) streamedArtifactIdsRef.current.add(opts.artifactId);
      return;
    }

    const loaded = await loadFileContent({
      workspacePath,
      filePath,
      artifactContent: opts.artifactContent,
      preferDisk: opts.preferDisk,
    });
    setTabs((prev) => {
      const nextTab = makeTab({ filePath: resolved, displayPath, content: loaded.content, source: loaded.source, error: loaded.error });
      const exists = prev.some((tab) => tab.filePath === resolved);
      return exists ? prev.map((tab) => (tab.filePath === resolved ? nextTab : tab)) : [...prev, nextTab];
    });
    setActivePath(resolved);
  }, [workspacePath]);

  useEffect(() => {
    if (!latestFileArtifact || streamedArtifactIdsRef.current.has(latestFileArtifact.id)) return;
    void openFile(latestFileArtifact.title, {
      artifactId: latestFileArtifact.id,
      artifactContent: latestFileArtifact.detail,
      preferDisk: latestFileArtifact.action === "edit",
      stream: true,
    });
  }, [latestFileArtifact, openFile]);

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => window.clearInterval(timer));
      timersRef.current.clear();
    };
  }, []);

  return (
    <section className="glass flex min-h-[420px] flex-1 overflow-hidden rounded-2xl border border-white/5" aria-label={t("chat.workPanel.ideTitle")}>
      {workspacePath && (
        <div className="hidden shrink-0 md:flex">
          <div
            className="min-w-0 shrink-0 bg-foreground/[0.035] flex flex-col"
            style={{ width: fileTreePanel.width }}
          >
            <div className="flex h-9 items-center gap-1.5 border-b border-border px-3 text-[10px] font-black uppercase tracking-[0.16em] text-muted-foreground/55">
              <FileText className="w-3 h-3" />
              {t("chat.workPanel.files")}
            </div>
            <div className="min-h-0 flex-1">
              <FileTree rootPath={workspacePath} activePath={activePath} onOpenFile={(path) => void openFile(path, { preferDisk: true })} />
            </div>
          </div>
          <ResizeHandle onMouseDown={fileTreePanel.onMouseDown} className="border-r border-border bg-foreground/[0.025]" />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TabBar tabs={tabs} activePath={activePath} onSelect={setActivePath} onClose={closeTab} />
        <div className="min-h-0 flex-1">
          {activeTab ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-[11px] font-bold uppercase tracking-widest text-muted-foreground/50">
                  {t("common.loading")}
                </div>
              }
            >
              <CodeEditor key={activeTab.filePath} tab={activeTab} />
            </Suspense>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-muted-foreground">
              <Code2 className="w-8 h-8 text-primary/50" />
              <div className="text-xs font-bold text-foreground/80">{t("chat.workPanel.noFileOpen")}</div>
              <div className="max-w-xs text-[11px] leading-relaxed text-muted-foreground/55">
                {workspacePath ? t("chat.workPanel.noFileOpenHint") : t("chat.workPanel.noWorkspaceHint")}
              </div>
            </div>
          )}
        </div>
        <div className="flex h-8 items-center gap-3 border-t border-border bg-foreground/[0.04] px-3 text-[10px] text-muted-foreground">
          {running && <Loader2 className="w-3 h-3 animate-spin text-primary" />}
          <span className={cn("truncate", running ? "text-primary" : "text-muted-foreground")}>{activeLabel}</span>
          {activeTab && (
            <>
              <span className="text-muted-foreground/35">|</span>
              <span>{activeTab.language}</span>
              <span className="text-muted-foreground/35">|</span>
              <span className="truncate">{activeTab.displayPath}</span>
              {activeTab.isStreaming && (
                <span className="ml-auto text-primary">
                  {t("chat.workPanel.streamingLines", { current: activeTab.streamedLines, total: activeTab.totalLines })}
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
