import { mcpServers } from "@/lib/db";
import type { McpServerRow } from "@/lib/db/mcp";
import { deleteApiKey, getApiKey, saveApiKey } from "@/lib/keystore";

export interface McpServerSecrets {
  headers: Record<string, string>;
  env: Record<string, string>;
}

function credentialIdForServer(serverId: string): string {
  return `mcp-server:${serverId}`;
}

function parseSecrets(value: string | null): McpServerSecrets {
  if (!value) return { headers: {}, env: {} };
  try {
    const parsed = JSON.parse(value) as Partial<McpServerSecrets>;
    const stringRecord = (record: unknown): Record<string, string> => {
      if (!record || typeof record !== "object" || Array.isArray(record)) return {};
      return Object.fromEntries(
        Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
    };
    return {
      headers: stringRecord(parsed.headers),
      env: stringRecord(parsed.env),
    };
  } catch {
    return { headers: {}, env: {} };
  }
}

export async function saveMcpServerSecrets(serverId: string, secrets: McpServerSecrets): Promise<void> {
  const credentialId = credentialIdForServer(serverId);
  await saveApiKey(credentialId, JSON.stringify(secrets));
  await mcpServers.setSecretCredential(serverId, credentialId);
}

export async function hydrateMcpServerSecrets(server: McpServerRow): Promise<McpServerRow> {
  if (server.secretCredentialId) {
    const secrets = parseSecrets(await getApiKey(server.secretCredentialId));
    return { ...server, headers: secrets.headers, env: secrets.env };
  }
  if (Object.keys(server.headers).length === 0 && Object.keys(server.env).length === 0) {
    return server;
  }

  // One-time migration for configurations created before secrets moved to the OS credential store.
  const secrets = { headers: server.headers, env: server.env };
  await saveMcpServerSecrets(server.id, secrets);
  return { ...server, secretCredentialId: credentialIdForServer(server.id), ...secrets };
}

export async function deleteMcpServerSecrets(server: McpServerRow): Promise<void> {
  if (server.secretCredentialId) {
    await deleteApiKey(server.secretCredentialId);
  }
}

export async function migrateLegacyMcpServerSecrets(): Promise<void> {
  const servers = await mcpServers.list();
  for (const server of servers) {
    if (!server.secretCredentialId
      && (Object.keys(server.headers).length > 0 || Object.keys(server.env).length > 0)) {
      await hydrateMcpServerSecrets(server);
    }
  }
}
