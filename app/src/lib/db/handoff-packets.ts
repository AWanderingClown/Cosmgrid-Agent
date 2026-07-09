import { getDb } from "./connection";
import { newId, now } from "./utils";
import { checkpoints, type Checkpoint } from "./checkpoints";

// ============ handoffPackets CRUD（4.10：交接包 = 检查点字段拼成的 markdown）============

interface HandoffPacketRow {
  id: string;
  project_id: string;
  checkpoint_id: string;
  target_role: string;
  target_model_id: string | null;
  format: string;
  content: string;
  created_at: string;
}

export interface HandoffPacket {
  id: string;
  projectId: string;
  checkpointId: string;
  targetRole: string;
  targetModelId: string | null;
  format: string;
  content: string;
  createdAt: string;
}

function rowToHandoffPacket(r: HandoffPacketRow): HandoffPacket {
  return {
    id: r.id,
    projectId: r.project_id,
    checkpointId: r.checkpoint_id,
    targetRole: r.target_role,
    targetModelId: r.target_model_id,
    format: r.format,
    content: r.content,
    createdAt: r.created_at,
  };
}

export interface CreateHandoffPacketInput {
  projectId: string;
  checkpointId: string;
  targetRole: string;
  targetModelId?: string | null;
  format?: string;
  content: string;
}

/**
 * 把 Checkpoint 字段拼成给下一个角色看的 markdown 交接包
 * v0.7 i18n 化：接受 t 函数，让 markdown 标签跟用户当前语言走
 * （已存的旧 handoff 内容不会被重新翻译——只在新建时用新语言）
 */
export function renderHandoffMarkdown(
  cp: Checkpoint,
  targetRole: string,
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  const section = (fieldKey: string, value: string | null): string[] => [
    `## ${t(`projectDetail.fields.${fieldKey}`)}`,
    value && value.trim() ? value.trim() : t("handoffMarkdown.empty"),
    "",
  ];
  const parts: string[] = [];
  parts.push(`# ${t("handoffMarkdown.title", { role: targetRole })}`);
  parts.push("");
  parts.push(t("handoffMarkdown.sourceCheckpoint", { title: cp.title }));
  parts.push(t("handoffMarkdown.generatedAt", { time: cp.createdAt }));
  parts.push("");
  parts.push(...section("goal", cp.goal));
  parts.push(...section("completedSummary", cp.completedSummary));
  parts.push(...section("currentContext", cp.currentContext));
  parts.push(...section("decisions", cp.decisions));
  parts.push(...section("failedAttempts", cp.failedAttempts));
  parts.push(...section("blockers", cp.blockers));
  parts.push(...section("nextSteps", cp.nextSteps));
  parts.push(...section("doNotRepeat", cp.doNotRepeat));
  parts.push(...section("acceptanceCriteria", cp.acceptanceCriteria));
  return parts.join("\n").trimEnd() + "\n";
}

export const handoffPackets = {
  async listByProject(projectId: string): Promise<HandoffPacket[]> {
    const db = await getDb();
    const rows = await db.select<HandoffPacketRow[]>(
      "SELECT * FROM handoff_packets WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId]
    );
    return rows.map(rowToHandoffPacket);
  },

  async getById(id: string): Promise<HandoffPacket | null> {
    const db = await getDb();
    const rows = await db.select<HandoffPacketRow[]>(
      "SELECT * FROM handoff_packets WHERE id = $1",
      [id]
    );
    return rows[0] ? rowToHandoffPacket(rows[0]) : null;
  },

  async create(input: CreateHandoffPacketInput): Promise<HandoffPacket> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO handoff_packets
        (id, project_id, checkpoint_id, target_role, target_model_id, format, content, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        input.projectId,
        input.checkpointId,
        input.targetRole,
        input.targetModelId ?? null,
        input.format ?? "markdown",
        input.content,
        ts,
      ]
    );
    return (await handoffPackets.getById(id))!;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM handoff_packets WHERE id = $1", [id]);
  },

  /**
   * 把 checkpoint 字段拼成 markdown，生成一条 handoff_packets 记录。
   * checkpoint 不存在时抛错。
   * v0.7 i18n 化：接受 t 函数让内容跟当前语言走
   */
  async generate(
    checkpointId: string,
    targetRole: string,
    t: (k: string, opts?: Record<string, unknown>) => string,
    targetModelId?: string | null,
  ): Promise<HandoffPacket> {
    const cp = await checkpoints.getById(checkpointId);
    if (!cp) {
      throw new Error(`checkpoint ${checkpointId} not found`);
    }
    const content = renderHandoffMarkdown(cp, targetRole, t);
    return handoffPackets.create({
      projectId: cp.projectId,
      checkpointId,
      targetRole,
      targetModelId: targetModelId ?? null,
      content,
    });
  },
};
