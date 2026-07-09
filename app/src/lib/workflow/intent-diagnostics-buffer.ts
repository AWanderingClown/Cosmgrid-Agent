import type { TurnIntentDecision } from "./types";
import type { SemanticIntentRoute } from "./semantic-intent-router";

/**
 * L9 意图识别细节面板的环形缓冲。
 *
 * 设计目标（参考 v3.4 §0.3 产物纪律 + AGENTS.md"别把代码堆回大文件"）：
 * - 仅做会话内调试态信号，不落库（避免污染 L0 审计事实表）。
 * - 仅由 useChatStream 在 classifyTurnIntentWithJudge() 后 append 一次。
 * - 上限 10 条，超出按 FIFO 丢弃最早。
 * - sessionStorage 持久化（重启 App 可看最近一轮，关闭 tab 即清）。
 *
 * Why sessionStorage 不是 localStorage / 内存：
 * - 内存：刷新就丢，调试体验差。
 * - localStorage：跨 tab 共享，会出现"我这边调试的入口被另一个 tab 覆盖"。
 * - sessionStorage：当前 tab 内持久化 + 跨刷新 + 不跨 tab，调试面板的理想语义。
 */

export const INTENT_DIAGNOSTICS_BUFFER_KEY = "cosmgrid.intentDiagnostics.v1";
export const INTENT_DIAGNOSTICS_MAX = 10;

export type IntentDecisionLayer = "L0-rule" | "L1-semantic" | "L2-judge" | "L3-state-machine" | "unknown";

export interface IntentDiagnosticsEntry {
  readonly id: string;
  readonly capturedAt: string;
  readonly userTextExcerpt: string;
  readonly decision: TurnIntentDecision;
  readonly route: SemanticIntentRoute;
}

export type IntentDiagnosticsListener = (entries: readonly IntentDiagnosticsEntry[]) => void;

const listeners = new Set<IntentDiagnosticsListener>();

function isEntry(value: unknown): value is IntentDiagnosticsEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string"
    && typeof v.capturedAt === "string"
    && typeof v.userTextExcerpt === "string"
    && typeof v.decision === "object"
    && typeof v.route === "object";
}

function getStorage(): Storage | null {
  if (typeof globalThis === "undefined") return null;
  const candidate = (globalThis as { sessionStorage?: Storage }).sessionStorage;
  return candidate ?? null;
}

export function readIntentDiagnostics(): IntentDiagnosticsEntry[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(INTENT_DIAGNOSTICS_BUFFER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).slice(-INTENT_DIAGNOSTICS_MAX);
  } catch {
    return [];
  }
}

function persist(entries: readonly IntentDiagnosticsEntry[]): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(INTENT_DIAGNOSTICS_BUFFER_KEY, JSON.stringify(entries));
  } catch {
    // sessionStorage 满 / disabled / privacy mode：静默吞，不影响主对话
  }
}

export function appendIntentDiagnostics(entry: IntentDiagnosticsEntry): void {
  const current = readIntentDiagnostics();
  const next = [...current, entry].slice(-INTENT_DIAGNOSTICS_MAX);
  persist(next);
  // 隔离单个 listener 异常：一个订阅者抛错不影响其他订阅者（与 persist/read 的 catch 风格一致）
  listeners.forEach((listener) => {
    try {
      listener(next);
    } catch {
      // ignore
    }
  });
}

export function clearIntentDiagnostics(): void {
  persist([]);
  for (const listener of listeners) listener([]);
}

export function subscribeIntentDiagnostics(listener: IntentDiagnosticsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
