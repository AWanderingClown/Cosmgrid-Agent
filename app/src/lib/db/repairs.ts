import { inferModelCapabilities } from "../llm/model-capabilities";
import type { DatabaseLike } from "../db-migrations";

function now(): string {
  return new Date().toISOString();
}

export async function repairCliPresetModels(db: DatabaseLike): Promise<void> {
  const rows = await db.select<Array<{ id: string; name: string; provider_type: string }>>(`
    SELECT m.id, m.name, p.type AS provider_type
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE p.type IN ('claude-cli', 'codex-cli')
  `);

  for (const row of rows) {
    const normalized = row.name.toLowerCase().replace(/[\s_]/g, "-");
    let nextName: string | null = null;
    let nextDisplayName: string | null = null;

    if (row.provider_type === "claude-cli" && ["claude-opus-4-8", "opus"].includes(normalized)) {
      nextName = "sonnet";
      nextDisplayName = "Claude Sonnet";
    } else if (
      row.provider_type === "codex-cli" &&
      ["gpt-5.5-codex", "gpt5.5-codex", "gpt-5.5", "gpt5.5"].includes(normalized)
    ) {
      nextName = "gpt-5.5";
      nextDisplayName = "GPT 5.5";
    }

    if (!nextName) continue;
    const inferred = inferModelCapabilities(nextName);
    await db.execute(
      `UPDATE models
       SET name = $1, display_name = $2, capability_score = $3, work_roles = $4, updated_at = $5
       WHERE id = $6`,
      [
        nextName,
        nextDisplayName,
        JSON.stringify(inferred.capabilityScore),
        JSON.stringify(inferred.workRoles),
        now(),
        row.id,
      ],
    );
  }
}

export async function clearIdleLeaderOnlyOrchestration(db: DatabaseLike): Promise<void> {
  const rows = await db.select<Array<{ id: string; orchestration: string | null }>>(`
    SELECT id, orchestration
    FROM conversations
    WHERE orchestration IS NOT NULL AND orchestration <> ''
  `);

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.orchestration ?? "") as {
        nodes?: Array<{ role?: string; pinned?: boolean }>;
        chainPlan?: unknown[];
      };
      const nodes = parsed.nodes ?? [];
      const chainPlan = parsed.chainPlan ?? [];
      const isIdleLeaderOnly =
        nodes.length === 1 &&
        nodes[0]?.role === "leader" &&
        nodes[0]?.pinned !== true &&
        chainPlan.length === 0;

      if (isIdleLeaderOnly) {
        await db.execute("UPDATE conversations SET orchestration = NULL WHERE id = $1", [row.id]);
      }
    } catch {
      // 坏 JSON 不处理，避免误删用户真实工作链路。
    }
  }
}
