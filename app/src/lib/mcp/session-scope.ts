import type { McpServerRow } from "@/lib/db/mcp";

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sortedRecord(record: Record<string, string>): Array<[string, string]> {
  return Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
}

export interface LocalMcpSessionScope {
  key: string;
  sessionId: string;
  configFingerprint: string;
}

export function buildLocalMcpSessionScope(
  server: Pick<McpServerRow, "id" | "command" | "args" | "env">,
  workspacePath?: string,
): LocalMcpSessionScope {
  const configFingerprint = stableHash(JSON.stringify({
    command: server.command,
    args: server.args,
    env: sortedRecord(server.env),
  }));
  const workspaceFingerprint = stableHash(workspacePath || "<no-workspace>");
  const key = `${server.id}::${workspaceFingerprint}::${configFingerprint}`;
  return {
    key,
    sessionId: `mcp-${stableHash(key)}`,
    configFingerprint,
  };
}

export function formatLocalMcpLaunch(server: Pick<McpServerRow, "command" | "args" | "env">, workspacePath?: string): string {
  const command = [server.command, ...server.args].filter(Boolean).join(" ");
  const envNames = Object.keys(server.env).sort();
  return [
    `命令：${command}`,
    `工作目录：${workspacePath || "无工作区"}`,
    `环境变量：${envNames.length > 0 ? envNames.join(", ") : "无"}`,
  ].join("\n");
}
