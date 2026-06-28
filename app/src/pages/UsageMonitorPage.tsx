import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Gauge, RefreshCw, DatabaseZap, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TokenPlansPage } from "@/pages/TokenPlansPage";
import { StatsPage } from "@/pages/StatsPage";
import { cn } from "@/lib/utils";
import { priceSyncStatus, type PriceSyncStatus } from "@/lib/db";
import { syncModelPrices } from "@/lib/llm/price-catalog";

type UsageTab = "plans" | "details";

export function UsageMonitorPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<UsageTab>("details");
  const [status, setStatus] = useState<PriceSyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);

  async function loadStatus() {
    setStatus(await priceSyncStatus.get());
  }

  useEffect(() => {
    void loadStatus();
  }, []);

  async function handleSync() {
    setSyncing(true);
    try {
      await syncModelPrices();
    } finally {
      await loadStatus();
      setSyncing(false);
    }
  }

  return (
    <div className="h-full w-full overflow-hidden bg-background/30 backdrop-blur-sm flex flex-col">
      <div className="shrink-0 px-8 pt-8 space-y-4">
        <div className="glass border-white/10 rounded-2xl p-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-primary">
              <DatabaseZap className="w-4 h-4" />
              {t("usageMonitor.priceCatalog")}
            </div>
            <div className="text-sm text-muted-foreground">
              {status?.lastSuccessAt
                ? t("usageMonitor.priceUpdatedAt", { time: new Date(status.lastSuccessAt).toLocaleString() })
                : t("usageMonitor.priceNeverSynced")}
            </div>
            {status?.lastError ? (
              <div className="flex items-center gap-2 text-xs text-amber-500">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {t("usageMonitor.priceSyncFailed", { reason: status.lastError })}
              </div>
            ) : null}
          </div>
          <Button type="button" onClick={() => void handleSync()} disabled={syncing} className="rounded-xl gap-2 self-start lg:self-auto">
            <RefreshCw className={cn("w-4 h-4", syncing && "animate-spin")} />
            {syncing ? t("usageMonitor.priceSyncing") : t("usageMonitor.priceSyncNow")}
          </Button>
        </div>

        <div className="glass border-white/10 rounded-2xl p-1 flex w-fit gap-1">
          <UsageTabButton
            active={tab === "details"}
            icon={<Activity className="w-4 h-4" />}
            label={t("usageMonitor.detailsTab")}
            onClick={() => setTab("details")}
          />
          <UsageTabButton
            active={tab === "plans"}
            icon={<Gauge className="w-4 h-4" />}
            label={t("usageMonitor.plansTab")}
            onClick={() => setTab("plans")}
          />
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <div className="h-full w-full" style={{ display: tab === "details" ? "block" : "none" }}>
          <StatsPage />
        </div>
        <div className="h-full w-full" style={{ display: tab === "plans" ? "block" : "none" }}>
          <TokenPlansPage />
        </div>
      </div>
    </div>
  );
}

function UsageTabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className={cn(
        "rounded-xl h-10 px-4 text-xs font-bold gap-2",
        active
          ? "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-white/10",
      )}
    >
      {icon}
      {label}
    </Button>
  );
}
