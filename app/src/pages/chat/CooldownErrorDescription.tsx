import { useEffect, useMemo, useState } from "react";
import {
  formatCooldownCountdownMessage,
  parseCooldownCountdownMessage,
} from "./cooldown-error";

export function CooldownErrorDescription({
  message,
  onExpired,
}: {
  message: string;
  onExpired?: () => void;
}) {
  const parsed = useMemo(() => parseCooldownCountdownMessage(message), [message]);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!parsed) return;
    const startedAt = Date.now();
    setElapsedMs(0);
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [parsed]);

  useEffect(() => {
    if (!parsed) return;
    const maxRemainingMs = Math.max(...parsed.entries.map((entry) => entry.remainingMs));
    if (elapsedMs >= maxRemainingMs) onExpired?.();
  }, [elapsedMs, onExpired, parsed]);

  return <>{parsed ? formatCooldownCountdownMessage(parsed, elapsedMs) : message}</>;
}
