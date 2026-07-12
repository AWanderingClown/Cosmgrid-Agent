/**
 * Skill 域 seed 流程（引擎化阶段 1b）。
 *
 * 项目启动 initSchemaForDb 跑完后调一次：
 *   - 表已就位（202607120020 / 202607120021 已跑）
 *   - 把 CORE_SKILLS 三条按 builtin seed 写进 skill_definitions
 *   - 幂等：seedBuiltinIfMissing 用 builtin_version 戳判定，已存在跳过
 *
 * 不在 initSchemaForDb 里直接塞——避免 lib/db 依赖 lib/skills（L0 规则禁）。
 * 改为入口 App.tsx 在 initSchema + seedBuiltInTemplates 后调一次。
 */

import { skillDefinitions } from "@/lib/db/skill-definitions";
import { skillAuditLog } from "@/lib/db/skill-audit-log";
import { CORE_SKILLS, SKILL_BUILTIN_VERSION } from "./registry";

export async function seedBuiltinSkills(): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const skill of CORE_SKILLS) {
    const result = await skillDefinitions.seedBuiltinIfMissing({
      id: skill.id,
      builtinVersion: SKILL_BUILTIN_VERSION,
      label: skill.label,
      purpose: skill.purpose,
      triggerPhases: skill.triggerPhases as unknown as string[],
      triggerKeywords: skill.triggerKeywords,
      requiredCapabilities: skill.requiredCapabilities,
      systemGuidance: skill.systemGuidance,
      acceptanceCriteria: skill.acceptanceCriteria,
    });
    if (result === "inserted") {
      await skillAuditLog.record({
        skillId: skill.id,
        action: "register",
        actor: "builtin-seed",
        notes: `seeded by ${SKILL_BUILTIN_VERSION}`,
      });
      inserted++;
    } else {
      skipped++;
    }
  }
  return { inserted, skipped };
}
