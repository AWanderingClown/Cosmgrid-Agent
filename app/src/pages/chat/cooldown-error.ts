export interface CooldownCountdownEntry {
  modelName: string;
  remainingMs: number;
}

export interface CooldownCountdownMessage {
  entries: CooldownCountdownEntry[];
}

const COOLDOWN_ENTRY_RE = /([^：、。]+?)（还需\s*(?:(\d+)\s*分(?:钟)?)?\s*(?:(\d+)\s*秒)?）/g;

export function parseCooldownCountdownMessage(message: string): CooldownCountdownMessage | null {
  if (!message.includes("所有可用模型目前都在冷却中")) return null;

  const entries: CooldownCountdownEntry[] = [];
  for (const match of message.matchAll(COOLDOWN_ENTRY_RE)) {
    const modelName = match[1]?.trim();
    const minutes = Number(match[2] ?? 0);
    const seconds = Number(match[3] ?? 0);
    const remainingMs = (minutes * 60 + seconds) * 1000;
    if (!modelName || remainingMs <= 0) continue;
    entries.push({ modelName, remainingMs });
  }

  return entries.length > 0 ? { entries } : null;
}

export function formatCooldownRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0 && seconds > 0) return `${minutes} 分 ${seconds} 秒`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${seconds} 秒`;
}

export function formatCooldownCountdownMessage(message: CooldownCountdownMessage, elapsedMs: number): string {
  const activeEntries = message.entries
    .map((entry) => ({
      ...entry,
      remainingMs: Math.max(0, entry.remainingMs - elapsedMs),
    }))
    .filter((entry) => entry.remainingMs > 0);

  if (activeEntries.length === 0) {
    return "模型冷却已结束，可以重试了。";
  }

  const detail = activeEntries
    .map((entry) => `${entry.modelName}（还需 ${formatCooldownRemaining(entry.remainingMs)}）`)
    .join("、");

  return `所有可用模型目前都在冷却中：${detail}。倒计时结束后可以继续发送`;
}
