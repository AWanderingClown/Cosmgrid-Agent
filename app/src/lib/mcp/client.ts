import { JsonRpcClient } from "@/lib/rpc/rpc-client";
import { TauriRpcTransport } from "@/lib/rpc/tauri-transport";
import type { McpServerRow } from "@/lib/db/mcp";
import type { McpToolCallResult, McpToolLike } from "@/lib/llm/tools/mcp-tool-adapter";
import { buildLocalMcpSessionScope } from "./session-scope";

interface McpToolListResult {
  tools?: McpToolLike[];
  nextCursor?: string;
}

interface LocalMcpSession {
  client: JsonRpcClient;
  transport: TauriRpcTransport;
}

type RemoteClientModule = typeof import("./remote-client");

const localSessions = new Map<string, Promise<LocalMcpSession>>();
const MCP_PROTOCOL_VERSION = "2025-11-25";
let remoteClientModulePromise: Promise<RemoteClientModule> | null = null;

function loadRemoteClient(): Promise<RemoteClientModule> {
  remoteClientModulePromise ??= import("./remote-client");
  return remoteClientModulePromise;
}

export function hasKnownMcpSessions(): boolean {
  return localSessions.size > 0 || remoteClientModulePromise !== null;
}

async function getLocalSession(server: McpServerRow, workspacePath?: string): Promise<LocalMcpSession> {
  const scope = buildLocalMcpSessionScope(server, workspacePath);
  const key = scope.key;
  await disposeStaleLocalConfigSessions(server.id, scope.configFingerprint);
  let promise = localSessions.get(key);
  if (!promise) {
    promise = (async () => {
      if (!server.command) throw new Error(`MCP server ${server.name} has no command`);
      const transport = new TauriRpcTransport({
        sessionId: scope.sessionId,
        program: server.command,
        args: server.args,
        cwd: workspacePath || null,
        env: server.env,
        framing: "newline",
      });
      const client = new JsonRpcClient(transport, { timeoutMs: 30_000 });
      await transport.start();
      await client.call("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "Cosmgrid-Agent", version: "0.1" },
      });
      await client.notify("notifications/initialized");
      return { client, transport };
    })().catch((error) => {
      localSessions.delete(key);
      throw error;
    });
    localSessions.set(key, promise);
  }
  return promise;
}

async function disposeStaleLocalConfigSessions(serverId: string, configFingerprint: string): Promise<void> {
  const entries = [...localSessions.entries()].filter(([key]) => (
    key.startsWith(`${serverId}::`) && !key.endsWith(`::${configFingerprint}`)
  ));
  for (const [key] of entries) localSessions.delete(key);
  const settled = await Promise.allSettled(entries.map(([, session]) => session));
  await Promise.all(settled.map((entry) => {
    if (entry.status !== "fulfilled") return Promise.resolve();
    entry.value.client.dispose();
    return entry.value.transport.dispose();
  }));
}

export async function listMcpTools(server: McpServerRow, workspacePath?: string): Promise<McpToolLike[]> {
  if (server.transport === "remote_http") {
    const { listRemoteMcpTools } = await loadRemoteClient();
    return listRemoteMcpTools(server);
  }
  const session = await getLocalSession(server, workspacePath);
  const { listAllRemoteTools } = await loadRemoteClient();
  return listAllRemoteTools({
    listTools: (params) => session.client.call<McpToolListResult>("tools/list", params),
  });
}

export async function callMcpTool(
  server: McpServerRow,
  toolName: string,
  input: unknown,
  workspacePath?: string,
): Promise<McpToolCallResult> {
  const params = { name: toolName, arguments: input };
  if (server.transport === "remote_http") {
    const { callRemoteMcpTool } = await loadRemoteClient();
    return callRemoteMcpTool(server, toolName, input);
  }
  const session = await getLocalSession(server, workspacePath);
  return session.client.call<McpToolCallResult>("tools/call", params);
}

export async function disposeLocalMcpSessions(): Promise<void> {
  const settled = await Promise.allSettled([...localSessions.values()]);
  localSessions.clear();
  await Promise.all(settled.map((entry) => {
    if (entry.status !== "fulfilled") return Promise.resolve();
    entry.value.client.dispose();
    return entry.value.transport.dispose();
  }));
}

export async function disposeAllMcpSessions(): Promise<void> {
  const remoteClient = remoteClientModulePromise ? await remoteClientModulePromise : null;
  await Promise.all([
    disposeLocalMcpSessions(),
    remoteClient ? remoteClient.disposeRemoteMcpSessions() : Promise.resolve(),
  ]);
}

export async function disposeMcpServerSessions(serverId: string): Promise<void> {
  const entries = [...localSessions.entries()].filter(([key]) => key.startsWith(`${serverId}::`));
  for (const [key] of entries) localSessions.delete(key);
  const settled = await Promise.allSettled(entries.map(([, session]) => session));
  await Promise.all(settled.map((entry) => {
    if (entry.status !== "fulfilled") return Promise.resolve();
    entry.value.client.dispose();
    return entry.value.transport.dispose();
  }));
  const remoteClient = remoteClientModulePromise ? await remoteClientModulePromise : null;
  await remoteClient?.disposeRemoteMcpServerSessions(serverId);
}
