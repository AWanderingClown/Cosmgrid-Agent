import { JsonRpcClient } from "@/lib/rpc/rpc-client";
import { TauriRpcTransport } from "@/lib/rpc/tauri-transport";
import type { McpServerRow } from "@/lib/db/mcp";
import type { McpToolCallResult, McpToolLike } from "@/lib/llm/tools/mcp-tool-adapter";

interface JsonRpcEnvelope<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  method?: string;
  params?: unknown;
  result?: T;
  error?: { message?: string; code?: number };
}

interface McpToolListResult {
  tools?: McpToolLike[];
}

interface LocalMcpSession {
  client: JsonRpcClient;
  transport: TauriRpcTransport;
}

const localSessions = new Map<string, Promise<LocalMcpSession>>();
let nextHttpId = 1;

function localSessionId(server: McpServerRow): string {
  return `mcp-${server.id}`;
}

async function postJsonRpc<T>(server: McpServerRow, method: string, params?: unknown): Promise<T> {
  if (!server.url) throw new Error(`MCP server ${server.name} has no URL`);
  const id = nextHttpId++;
  const body: JsonRpcEnvelope = params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      ...server.headers,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const payload = await response.json() as JsonRpcEnvelope<T>;
  if (payload.error) throw new Error(payload.error.message ?? `MCP JSON-RPC error ${payload.error.code ?? ""}`.trim());
  return payload.result as T;
}

async function getLocalSession(server: McpServerRow, workspacePath?: string): Promise<LocalMcpSession> {
  const key = server.id;
  let promise = localSessions.get(key);
  if (!promise) {
    promise = (async () => {
      if (!server.command) throw new Error(`MCP server ${server.name} has no command`);
      const transport = new TauriRpcTransport({
        sessionId: localSessionId(server),
        program: server.command,
        args: server.args,
        cwd: workspacePath || null,
        env: server.env,
        framing: "newline",
      });
      const client = new JsonRpcClient(transport, { timeoutMs: 30_000 });
      await transport.start();
      await client.call("initialize", {
        protocolVersion: "2024-11-05",
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

export async function listMcpTools(server: McpServerRow, workspacePath?: string): Promise<McpToolLike[]> {
  if (server.transport === "remote_http") {
    await postJsonRpc(server, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "Cosmgrid-Agent", version: "0.1" },
    }).catch(() => undefined);
    const result = await postJsonRpc<McpToolListResult>(server, "tools/list");
    return result.tools ?? [];
  }
  const session = await getLocalSession(server, workspacePath);
  const result = await session.client.call<McpToolListResult>("tools/list");
  return result.tools ?? [];
}

export async function callMcpTool(
  server: McpServerRow,
  toolName: string,
  input: unknown,
  workspacePath?: string,
): Promise<McpToolCallResult> {
  const params = { name: toolName, arguments: input };
  if (server.transport === "remote_http") {
    return postJsonRpc<McpToolCallResult>(server, "tools/call", params);
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
