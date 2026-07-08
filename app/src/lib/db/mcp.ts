import { getDb } from "./connection";
import { boolToInt, newId, now } from "./utils";

export type McpTransport = "remote_http" | "local_stdio";

export interface McpServerRow {
  id: string;
  name: string;
  transport: McpTransport;
  url: string | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  headers: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMcpServerInput {
  name: string;
  transport: McpTransport;
  url?: string | null;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export type UpdateMcpServerInput = Partial<CreateMcpServerInput>;

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseStringRecord(value: unknown): Record<string, string> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function mapRow(row: any): McpServerRow {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    url: row.url ?? null,
    command: row.command ?? null,
    args: parseStringArray(row.args_json),
    env: parseStringRecord(row.env_json),
    headers: parseStringRecord(row.headers_json),
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateInput(input: CreateMcpServerInput): void {
  if (!input.name.trim()) throw new Error("MCP server name is required");
  if (input.transport === "remote_http" && !input.url?.trim()) {
    throw new Error("Remote MCP server url is required");
  }
  if (input.transport === "local_stdio" && !input.command?.trim()) {
    throw new Error("Local MCP server command is required");
  }
}

export const mcpServers = {
  async list(): Promise<McpServerRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>("SELECT * FROM mcp_servers ORDER BY updated_at DESC");
    return rows.map(mapRow);
  },

  async listEnabled(): Promise<McpServerRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY updated_at DESC",
    );
    return rows.map(mapRow);
  },

  async create(input: CreateMcpServerInput): Promise<McpServerRow> {
    validateInput(input);
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO mcp_servers
        (id, name, transport, url, command, args_json, env_json, headers_json, enabled, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        input.name.trim(),
        input.transport,
        input.url?.trim() || null,
        input.command?.trim() || null,
        JSON.stringify(input.args ?? []),
        JSON.stringify(input.env ?? {}),
        JSON.stringify(input.headers ?? {}),
        boolToInt(input.enabled ?? true),
        ts,
        ts,
      ],
    );
    const created = await this.getById(id);
    if (!created) throw new Error("MCP server create failed");
    return created;
  },

  async getById(id: string): Promise<McpServerRow | null> {
    const db = await getDb();
    const rows = await db.select<any[]>("SELECT * FROM mcp_servers WHERE id = $1", [id]);
    return rows.length > 0 ? mapRow(rows[0]) : null;
  },

  async update(id: string, input: UpdateMcpServerInput): Promise<McpServerRow> {
    const existing = await this.getById(id);
    if (!existing) throw new Error("MCP server not found");
    const merged: CreateMcpServerInput = { ...existing, ...input };
    validateInput(merged);
    const db = await getDb();
    await db.execute(
      `UPDATE mcp_servers
       SET name=$1, transport=$2, url=$3, command=$4, args_json=$5, env_json=$6,
           headers_json=$7, enabled=$8, updated_at=$9
       WHERE id=$10`,
      [
        merged.name.trim(),
        merged.transport,
        merged.url?.trim() || null,
        merged.command?.trim() || null,
        JSON.stringify(merged.args ?? []),
        JSON.stringify(merged.env ?? {}),
        JSON.stringify(merged.headers ?? {}),
        boolToInt(merged.enabled ?? true),
        now(),
        id,
      ],
    );
    const updated = await this.getById(id);
    if (!updated) throw new Error("MCP server update failed");
    return updated;
  },

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const db = await getDb();
    await db.execute("UPDATE mcp_servers SET enabled = $1, updated_at = $2 WHERE id = $3", [
      boolToInt(enabled),
      now(),
      id,
    ]);
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM mcp_servers WHERE id = $1", [id]);
  },
};
