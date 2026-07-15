import { getSkillDefinition } from "./registry";
import type { AcceptanceCriterion } from "@/lib/llm/evidence/types";
import type { SelectedSkill, SkillDefinition } from "./types";

/** 验收标准既可能是旧的纯字符串，也可能是结构化 {id,description,kind}。渲染时统一取可读文本。 */
function renderCriterion(item: AcceptanceCriterion): string {
  return typeof item === "string" ? item : item.description;
}

/**
 * 把选中的 skill 渲染成注入 prompt 的 preamble。
 *
 * definitions：调用方（useChatStream）从 DB `listActive()` 加载的全集。传了就优先按它解析，
 * 这样 user/ops 注册的 skill 也能渲染；不传则回退到内置 CORE_SKILLS（保持旧行为 / 单测友好）。
 */
export function buildSkillPreamble(
  skill: SelectedSkill | null,
  definitions?: SkillDefinition[],
): string | null {
  if (!skill) return null;
  const definition =
    definitions?.find((d) => d.id === skill.id) ?? getSkillDefinition(skill.id);
  if (!definition) return null;

  return [
    `当前启用技能：${definition.label}`,
    `选择原因：${skill.reason}`,
    `目的：${definition.purpose}`,
    `需要能力：${definition.requiredCapabilities.join("、")}`,
    "执行规则：",
    ...definition.systemGuidance.map((item) => `- ${item}`),
    "验收标准：",
    ...definition.acceptanceCriteria.map((item) => `- ${renderCriterion(item)}`),
  ].join("\n");
}
