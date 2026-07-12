/**
 * skill_audit_log 表 DAO。
 *
 * 5 类 action：
 *   - register：首次创建（包括 builtin seed 也走一遍）
 *   - approve / reject：审核流程
 *   - update：source=user/ops 的技能内容有变更
 *   - retire：撤回（review_status → rejected）
 *
 * diff_json 字段：当 action=update 时存旧值/新值 summary（非必要，可以 null）；
 * 这是审计友好——日后追查"用户改坏了 prompt 注入"时分得清哪个版本。
 */

import { getDb } from "./connection";
import { newId, now } from "./utils";

export type SkillAuditAction =
  | "register"
  | "approve"
  | "reject"
  | "update"
  | "retire";

export interface SkillAuditRow {
  id: string;
  skillId: string;
  action: SkillAuditAction;
  actor: string | null;
  notes: string | null;
  diffJson: string | null;
  at: string;
}

interface DbRow {
  id: string;
  skill_id: string;
  action: string;
  actor: string | null;
  notes: string | null;
  diff_json: string | null;
  at: string;
}

function mapRow(r: DbRow): SkillAuditRow {
  return {
    id: r.id,
    skillId: r.skill_id,
    action: r.action as SkillAuditAction,
    actor: r.actor,
    notes: r.notes,
    diffJson: r.diff_json,
    at: r.at,
  };
}

export const skillAuditLog = {
  async record(input: {
    skillId: string;
    action: SkillAuditAction;
    actor?: string | null;
    notes?: string | null;
    diffJson?: string | null;
  }): Promise<void> {
    const db = await getDb();
    await db.execute(
      `INSERT INTO skill_audit_log (id, skill_id, action, actor, notes, diff_json, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        newId(),
        input.skillId,
        input.action,
        input.actor ?? null,
        input.notes ?? null,
        input.diffJson ?? null,
        now(),
      ],
    );
  },

  async listBySkill(skillId: string, limit = 50): Promise<SkillAuditRow[]> {
    const db = await getDb();
    const rows = await db.select<DbRow[]>(
      "SELECT * FROM skill_audit_log WHERE skill_id = $1 ORDER BY at DESC LIMIT $2",
      [skillId, limit],
    );
    return rows.map(mapRow);
  },

  async listAll(limit = 200): Promise<SkillAuditRow[]> {
    const db = await getDb();
    const rows = await db.select<DbRow[]>(
      "SELECT * FROM skill_audit_log ORDER BY at DESC LIMIT $1",
      [limit],
    );
    return rows.map(mapRow);
  },
};
