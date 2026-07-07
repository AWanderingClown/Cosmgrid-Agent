import { inferModelCapabilities } from "../model-capabilities";
import type { DatabaseLike } from "../db-migrations";

function now(): string {
  return new Date().toISOString();
}

/**
 * 修复 CLI 预设的历史遗留错误模型名（很早期 bug 曾把 Claude CLI 唯一模型误存成
 * "opus"/"claude-opus-4-8" 代表的其实是 Sonnet 这一档）。目标值是具体版本号
 * （"claude-sonnet-5"/"gpt-5.5"），跟 provider-presets.ts 的 defaultModel 保持一致
 * ——用户明确要求下拉菜单里看到具体版本号，不要 sonnet/opus 这种裸别名。
 *
 * 只处理单行的 provider：一个 claude-cli/codex-cli provider 底下已经有 2+ 个模型，
 * 说明走的是当前的多档位方案（一行叫 "claude-opus-4-8" 这时候就是正确的 Opus 档位本身，
 * 不是历史 bug），必须跳过，否则会被下面的重命名逻辑误伤成别的档位。
 */
export async function repairCliPresetModels(db: DatabaseLike): Promise<void> {
  const rows = await db.select<Array<{ id: string; name: string; provider_type: string; provider_id: string }>>(`
    SELECT m.id, m.name, p.type AS provider_type, m.provider_id
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE p.type IN ('claude-cli', 'codex-cli')
  `);

  const countByProvider = new Map<string, number>();
  for (const row of rows) {
    countByProvider.set(row.provider_id, (countByProvider.get(row.provider_id) ?? 0) + 1);
  }

  for (const row of rows) {
    if ((countByProvider.get(row.provider_id) ?? 0) > 1) continue;

    const normalized = row.name.toLowerCase().replace(/[\s_]/g, "-");
    let nextName: string | null = null;
    let nextDisplayName: string | null = null;

    if (row.provider_type === "claude-cli" && ["claude-opus-4-8", "opus", "sonnet"].includes(normalized)) {
      nextName = "claude-sonnet-5";
      nextDisplayName = "Sonnet 5";
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
