import { getSkillDefinition } from "./registry";
import type { SelectedSkill } from "./types";

export function buildSkillPreamble(skill: SelectedSkill | null): string | null {
  if (!skill) return null;
  const definition = getSkillDefinition(skill.id);
  if (!definition) return null;

  return [
    `当前启用技能：${definition.label}`,
    `选择原因：${skill.reason}`,
    `目的：${definition.purpose}`,
    `需要能力：${definition.requiredCapabilities.join("、")}`,
    "执行规则：",
    ...definition.systemGuidance.map((item) => `- ${item}`),
    "验收标准：",
    ...definition.acceptanceCriteria.map((item) => `- ${item}`),
  ].join("\n");
}
