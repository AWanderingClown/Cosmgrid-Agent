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
  secretCredentialId: string | null;
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
  secretCredentialId?: string | null;
  enabled?: boolean;
}

export type UpdateMcpServerInput = Partial<CreateMcpServerInput>;

export interface McpServerApprovalInput {
  serverId: string;
  workspacePath: string;
  configFingerprint: string;
}

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
    secretCredentialId: row.secret_credential_id ?? null,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateInput(input: CreateMcpServerInput): void {
  if (!input.name.trim() || input.name.trim().length > 100) {
    throw new Error("MCP server name must be between 1 and 100 characters");
  }
  if (input.transport === "remote_http" && !input.url?.trim()) {
    throw new Error("Remote MCP server url is required");
  }
  if (input.transport === "remote_http" && input.url) {
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw new Error("Remote MCP server url is invalid");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Remote MCP server url must use http or https");
    }
  }
  if (input.transport === "local_stdio" && !input.command?.trim()) {
    throw new Error("Local MCP server command is required");
  }
  if ((input.command?.length ?? 0) > 1024) {
    throw new Error("Local MCP server command is too long");
  }
  if ((input.args?.length ?? 0) > 128 || (input.args ?? []).some((arg) => arg.length > 4096)) {
    throw new Error("Local MCP server arguments exceed the supported limit");
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
        (id, name, transport, url, command, args_json, env_json, headers_json,
         secret_credential_id, enabled, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        input.name.trim(),
        input.transport,
        input.url?.trim() || null,
        input.command?.trim() || null,
        JSON.stringify(input.args ?? []),
        "{}",
        "{}",
        input.secretCredentialId ?? null,
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
    await db.execute("DELETE FROM mcp_server_approvals WHERE server_id = $1", [id]);
    await db.execute(
      `UPDATE mcp_servers
       SET name=$1, transport=$2, url=$3, command=$4, args_json=$5, env_json=$6,
           headers_json=$7, secret_credential_id=$8, enabled=$9, updated_at=$10
       WHERE id=$11`,
      [
        merged.name.trim(),
        merged.transport,
        merged.url?.trim() || null,
        merged.command?.trim() || null,
        JSON.stringify(merged.args ?? []),
        "{}",
        "{}",
        merged.secretCredentialId ?? null,
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
    if (!enabled) {
      await db.execute("DELETE FROM mcp_server_approvals WHERE server_id = $1", [id]);
    }
    await db.execute("UPDATE mcp_servers SET enabled = $1, updated_at = $2 WHERE id = $3", [
      boolToInt(enabled),
      now(),
      id,
    ]);
  },

  async setSecretCredential(id: string, credentialId: string | null): Promise<void> {
    const db = await getDb();
    await db.execute(
      `UPDATE mcp_servers
       SET secret_credential_id = $1, env_json = '{}', headers_json = '{}', updated_at = $2
       WHERE id = $3`,
      [credentialId, now(), id],
    );
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM mcp_server_approvals WHERE server_id = $1", [id]);
    await db.execute("DELETE FROM mcp_servers WHERE id = $1", [id]);
  },
};

export const mcpServerApprovals = {
  async isApproved(input: McpServerApprovalInput): Promise<boolean> {
    const db = await getDb();
    const rows = await db.select<Array<{ approved: number }>>(
      `SELECT 1 AS approved
       FROM mcp_server_approvals
       WHERE server_id = $1 AND workspace_path = $2 AND config_fingerprint = $3
       LIMIT 1`,
      [input.serverId, input.workspacePath, input.configFingerprint],
    );
    return rows.length > 0;
  },

  async approve(input: McpServerApprovalInput): Promise<void> {
    const db = await getDb();
    await db.execute(
      `INSERT OR REPLACE INTO mcp_server_approvals
        (server_id, workspace_path, config_fingerprint, approved_at)
       VALUES ($1, $2, $3, $4)`,
      [input.serverId, input.workspacePath, input.configFingerprint, now()],
    );
  },

  async revokeForServer(serverId: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM mcp_server_approvals WHERE server_id = $1", [serverId]);
  },
};
