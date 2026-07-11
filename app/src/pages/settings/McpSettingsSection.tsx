import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plug, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { mcpServerApprovals, mcpServers, type McpServerRow, type McpTransport } from "@/lib/db";
import { disposeMcpServerSessions, listMcpTools } from "@/lib/mcp/client";
import {
  deleteMcpServerSecrets,
  hydrateMcpServerSecrets,
  saveMcpServerSecrets,
} from "@/lib/mcp/secret-store";
import { buildLocalMcpSessionScope, formatLocalMcpLaunch } from "@/lib/mcp/session-scope";
import { cn } from "@/lib/utils";

const EMPTY_MCP_FORM = {
  name: "",
  transport: "remote_http" as McpTransport,
  url: "",
  command: "",
  argsJson: "[]",
  headersJson: "{}",
  envJson: "{}",
};

function parseStringRecord(raw: string) {
  const value = JSON.parse(raw || "{}");
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.values(value).some((item) => typeof item !== "string")
  ) {
    throw new Error("record values must be strings");
  }
  return value as Record<string, string>;
}

function parseMcpFormSecrets(form: typeof EMPTY_MCP_FORM) {
  const parsedArgs = JSON.parse(form.argsJson || "[]");
  if (!Array.isArray(parsedArgs) || parsedArgs.some((item) => typeof item !== "string")) {
    throw new Error("args must be a string array");
  }
  return {
    args: parsedArgs,
    headers: parseStringRecord(form.headersJson),
    env: parseStringRecord(form.envJson),
  };
}

export function McpSettingsSection() {
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const [serverList, setServerList] = useState<McpServerRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_MCP_FORM);

  async function reloadServers() {
    try {
      setServerList(await mcpServers.list());
    } catch {
      setServerList([]);
    }
  }

  useEffect(() => {
    void reloadServers();
  }, []);

  async function handleAddServer() {
    setMessage(null);
    let parsed: ReturnType<typeof parseMcpFormSecrets>;
    try {
      parsed = parseMcpFormSecrets(form);
    } catch {
      setMessage(t("settings.mcp.invalidArgs"));
      return;
    }

    try {
      const created = await mcpServers.create({
        name: form.name,
        transport: form.transport,
        url: form.transport === "remote_http" ? form.url : null,
        command: form.transport === "local_stdio" ? form.command : null,
        args: parsed.args,
        enabled: form.transport === "remote_http",
      });
      if (Object.keys(parsed.headers).length > 0 || Object.keys(parsed.env).length > 0) {
        await saveMcpServerSecrets(created.id, {
          headers: parsed.headers,
          env: parsed.env,
        });
      }
      setForm(EMPTY_MCP_FORM);
      setMessage(t("settings.mcp.saved"));
      await reloadServers();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("settings.mcp.saveFailed"));
    }
  }

  async function handleToggleServer(server: McpServerRow) {
    if (server.enabled) {
      await disposeMcpServerSessions(server.id);
    }
    await mcpServers.setEnabled(server.id, !server.enabled);
    await reloadServers();
  }

  async function handleDeleteServer(server: McpServerRow) {
    await disposeMcpServerSessions(server.id);
    await deleteMcpServerSecrets(server);
    await mcpServers.delete(server.id);
    await reloadServers();
  }

  async function handleTestServer(storedServer: McpServerRow) {
    setMessage(null);
    try {
      const server = await hydrateMcpServerSecrets(storedServer);
      if (server.transport === "local_stdio") {
        const scope = buildLocalMcpSessionScope(server);
        const approval = {
          serverId: server.id,
          workspacePath: "",
          configFingerprint: scope.configFingerprint,
        };
        if (!(await mcpServerApprovals.isApproved(approval))) {
          const approved = await confirm({
            title: t("settings.mcp.launchConfirmTitle"),
            description: formatLocalMcpLaunch(server),
            confirmText: t("settings.mcp.launchConfirm"),
            destructive: true,
          });
          if (!approved) return;
          await mcpServerApprovals.approve(approval);
        }
      }
      const tools = await listMcpTools(server);
      setMessage(t("settings.mcp.testSuccess", { count: tools.length }));
    } catch (error) {
      setMessage(t("settings.mcp.testFailed", {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  return (
    <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] p-8 space-y-8 shadow-xl">
      <div className="flex items-center gap-3 pb-4 border-b border-white/10">
        <Plug className="w-5 h-5 text-primary" />
        <h2 className="text-xl font-bold dark:text-white">{t("settings.mcp.title")}</h2>
      </div>
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground leading-relaxed">{t("settings.mcp.desc")}</p>
        <div className="grid gap-3 lg:grid-cols-2 p-5 bg-white/5 rounded-2xl border border-white/5">
          <div className="space-y-2">
            <Label className="text-xs font-bold opacity-60">{t("settings.mcp.name")}</Label>
            <Input
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder={t("settings.mcp.namePlaceholder")}
              className="rounded-xl border-white/10 bg-white/5 dark:bg-black/20 h-11 text-sm dark:text-white"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs font-bold opacity-60">{t("settings.mcp.transport")}</Label>
            <Select
              value={form.transport}
              onValueChange={(value) => {
                if (value === "remote_http" || value === "local_stdio") {
                  setForm((prev) => ({ ...prev, transport: value }));
                }
              }}
            >
              <SelectTrigger className="rounded-xl border-white/10 bg-white/5 dark:bg-black/20 h-11 text-sm dark:text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="glass border-white/10 rounded-xl">
                <SelectItem value="remote_http">{t("settings.mcp.remoteHttp")}</SelectItem>
                <SelectItem value="local_stdio">{t("settings.mcp.localStdio")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="text-xs font-bold opacity-60">
              {form.transport === "remote_http" ? t("settings.mcp.url") : t("settings.mcp.command")}
            </Label>
            <Input
              value={form.transport === "remote_http" ? form.url : form.command}
              onChange={(event) => {
                const key = form.transport === "remote_http" ? "url" : "command";
                setForm((prev) => ({ ...prev, [key]: event.target.value }));
              }}
              placeholder={form.transport === "remote_http" ? "http://127.0.0.1:3000/mcp" : "npx"}
              className="rounded-xl border-white/10 bg-white/5 dark:bg-black/20 h-11 text-sm dark:text-white"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs font-bold opacity-60">{t("settings.mcp.args")}</Label>
            <Input
              value={form.argsJson}
              onChange={(event) => setForm((prev) => ({ ...prev, argsJson: event.target.value }))}
              placeholder='["-y","@modelcontextprotocol/server-filesystem"]'
              className="rounded-xl border-white/10 bg-white/5 dark:bg-black/20 h-11 text-sm dark:text-white font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs font-bold opacity-60">{t("settings.mcp.headers")}</Label>
            <Input
              value={form.headersJson}
              onChange={(event) => setForm((prev) => ({ ...prev, headersJson: event.target.value }))}
              placeholder='{"Authorization":"Bearer ..."}'
              className="rounded-xl border-white/10 bg-white/5 dark:bg-black/20 h-11 text-sm dark:text-white font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs font-bold opacity-60">{t("settings.mcp.env")}</Label>
            <Input
              value={form.envJson}
              onChange={(event) => setForm((prev) => ({ ...prev, envJson: event.target.value }))}
              placeholder='{"TOKEN":"..."}'
              className="rounded-xl border-white/10 bg-white/5 dark:bg-black/20 h-11 text-sm dark:text-white font-mono"
            />
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              onClick={() => void handleAddServer()}
              disabled={!form.name.trim()}
              className="rounded-xl whitespace-nowrap"
            >
              {t("settings.mcp.add")}
            </Button>
          </div>
        </div>

        {message && <p className="text-xs text-primary font-bold">{message}</p>}

        <div className="space-y-3">
          {serverList.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("settings.mcp.empty")}</p>
          )}
          {serverList.map((server) => (
            <div key={server.id} className="flex flex-col gap-3 p-5 bg-white/5 rounded-2xl border border-white/5">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold truncate">{server.name}</span>
                    <Badge className="border-none bg-white/10 text-muted-foreground px-2 py-0.5">
                      {server.transport === "remote_http" ? t("settings.mcp.remoteHttp") : t("settings.mcp.localStdio")}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground font-mono truncate">
                    {server.transport === "remote_http" ? server.url : [server.command, ...server.args].filter(Boolean).join(" ")}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleTestServer(server)}
                    className="rounded-xl px-3"
                  >
                    {t("settings.mcp.test")}
                  </Button>
                  <button
                    role="switch"
                    aria-checked={server.enabled}
                    onClick={() => void handleToggleServer(server)}
                    className={cn(
                      "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-300",
                      server.enabled ? "bg-primary" : "bg-white/15",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-300",
                        server.enabled ? "translate-x-6" : "translate-x-1",
                      )}
                    />
                  </button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleDeleteServer(server)}
                    className="rounded-xl px-3"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
