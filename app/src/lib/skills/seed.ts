/**
 * Skill 域 seed 流程（引擎化阶段 1b）。
 *
 * 项目启动 initSchemaForDb 跑完后调一次：
 *   - 表已就位（202607120020 / 202607120021 已跑）
 *   - 把 CORE_SKILLS 三条按 builtin 写进 skill_definitions
 *   - 版本戳判定：DB 里的 builtin_version 与当前 SKILL_BUILTIN_VERSION 一致 → 跳过；
 *     不一致（内置 skill 有改动）→ upsert 覆盖，让改动传到已装好的 app，不只是全新安装。
 *     upsert 是"有则更新、无则插入"的原子操作（ON CONFLICT DO UPDATE），一步到位。
 *
 * 不在 initSchemaForDb 里直接塞——避免 lib/db 依赖 lib/skills（L0 规则禁）。
 * 改为入口 App.tsx 在 initSchema + seedBuiltInTemplates 后调一次。
 */

import { skillDefinitions } from "@/lib/db/skill-definitions";
import { skillAuditLog } from "@/lib/db/skill-audit-log";
import { now } from "@/lib/db/utils";
import { CORE_SKILLS, SKILL_BUILTIN_VERSION } from "./registry";

export async function seedBuiltinSkills(): Promise<{ inserted: number; reseeded: number; skipped: number }> {
  let inserted = 0;
  let reseeded = 0;
  let skipped = 0;
  for (const skill of CORE_SKILLS) {
    const existing = await skillDefinitions.getById(skill.id);
    // 已存在且版本一致 → 什么都不做。
    if (existing && existing.builtinVersion === SKILL_BUILTIN_VERSION) {
      skipped++;
      continue;
    }
    // 不存在 or 版本不一致 → upsert 覆盖（有则更新、无则插入）。
    await skillDefinitions.upsert({
      id: skill.id,
      builtinVersion: SKILL_BUILTIN_VERSION,
      label: skill.label,
      purpose: skill.purpose,
      triggerPhases: skill.triggerPhases as unknown as string[],
      triggerKeywords: skill.triggerKeywords,
      requiredCapabilities: skill.requiredCapabilities,
      systemGuidance: skill.systemGuidance,
      acceptanceCriteria: skill.acceptanceCriteria,
      source: "builtin",
      reviewStatus: "approved",
      reviewedBy: "builtin-seed",
      reviewedAt: now(),
    });
    await skillAuditLog.record({
      skillId: skill.id,
      action: "register",
      actor: "builtin-seed",
      notes: existing
        ? `re-seeded ${skill.id} → ${SKILL_BUILTIN_VERSION}`
        : `seeded by ${SKILL_BUILTIN_VERSION}`,
    });
    if (existing) reseeded++;
    else inserted++;
  }
  return { inserted, reseeded, skipped };
}
