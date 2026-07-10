import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerRow } from "@/lib/db/mcp";
import type { McpToolCallResult, McpToolLike } from "@/lib/llm/tools/mcp-tool-adapter";

interface ToolListPage {
  tools?: McpToolLike[];
  nextCursor?: string;
}

export interface RemoteToolListClient {
  listTools(params?: { cursor?: string }): Promise<ToolListPage>;
}

interface RemoteMcpSession {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

const remoteSessions = new Map<string, Promise<RemoteMcpSession>>();

export function hasRemoteMcpSessions(): boolean {
  return remoteSessions.size > 0;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function remoteSessionKey(server: McpServerRow): string {
  return `${server.id}::${stableHash(JSON.stringify({
    url: server.url,
    headers: Object.entries(server.headers).sort(([left], [right]) => left.localeCompare(right)),
  }))}`;
}

export async function listAllRemoteTools(client: RemoteToolListClient): Promise<McpToolLike[]> {
  const tools: McpToolLike[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...(page.tools ?? []));
    if (!page.nextCursor) return tools;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error(`MCP tools/list returned repeated cursor: ${page.nextCursor}`);
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

async function getRemoteSession(server: McpServerRow): Promise<RemoteMcpSession> {
  if (!server.url) throw new Error(`MCP server ${server.name} has no URL`);
  const key = remoteSessionKey(server);
  await disposeRemoteMcpServerSessions(server.id, key);
  let promise = remoteSessions.get(key);
  if (!promise) {
    promise = (async () => {
      const client = new Client({ name: "Cosmgrid-Agent", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(server.url!), {
        requestInit: { headers: server.headers },
      });
      await client.connect(transport);
      return { client, transport };
    })().catch((error) => {
      remoteSessions.delete(key);
      throw error;
    });
    remoteSessions.set(key, promise);
  }
  return promise;
}

export async function listRemoteMcpTools(server: McpServerRow): Promise<McpToolLike[]> {
  const session = await getRemoteSession(server);
  return listAllRemoteTools(session.client as unknown as RemoteToolListClient);
}

export async function callRemoteMcpTool(
  server: McpServerRow,
  toolName: string,
  input: unknown,
): Promise<McpToolCallResult> {
  const session = await getRemoteSession(server);
  return await session.client.callTool({
    name: toolName,
    arguments: input && typeof input === "object" ? input as Record<string, unknown> : {},
  }) as unknown as McpToolCallResult;
}

export async function disposeRemoteMcpSessions(): Promise<void> {
  const settled = await Promise.allSettled([...remoteSessions.values()]);
  remoteSessions.clear();
  await Promise.all(settled.map(async (entry) => {
    if (entry.status !== "fulfilled") return;
    await entry.value.transport.terminateSession().catch(() => undefined);
    await entry.value.client.close().catch(() => undefined);
  }));
}

export async function disposeRemoteMcpServerSessions(serverId: string, exceptKey?: string): Promise<void> {
  const entries = [...remoteSessions.entries()]
    .filter(([key]) => key.startsWith(`${serverId}::`) && key !== exceptKey);
  for (const [key] of entries) remoteSessions.delete(key);
  const settled = await Promise.allSettled(entries.map(([, session]) => session));
  await Promise.all(settled.map(async (entry) => {
    if (entry.status !== "fulfilled") return;
    await entry.value.transport.terminateSession().catch(() => undefined);
    await entry.value.client.close().catch(() => undefined);
  }));
}
