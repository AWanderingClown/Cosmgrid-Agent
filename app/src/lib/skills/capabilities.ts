/**
 * Skill 域专属 capability 治理：content blocklist patterns。
 *
 * 中立 capability 注册表（ALL_CAPABILITIES / checkSkillToolAccess）
 * 在 lib/llm/capability-registry.ts；本文件只承担 Skill 域的内容审查黑名单词（K12）。
 *
 * 注册新 skill 时调 findBlockedPhrase(systemGuidance)，命中任意一条 → 拒绝注册。
 * 这是 K7 真强制之外的第二道闸——前者管工具调用，后者管 skill 注入 prompt 时的内容。
 */

export {
  ALL_CAPABILITIES,
  checkSkillToolAccess,
  type Capability,
  type SkillToolAccessCheck,
} from "@/lib/llm/capability-registry";

/**
 * 退化诱导词黑名单（K12 §4.3 默认组合 → 兜底机制）：
 *   - "无需读取" 系列 → 跳过 Harness 第一道闸
 *   - "凭经验" / "通用经验" → 鼓励模板经验替代真实仓库
 *   - "不用验证" / "跳过 check" → 旁路验收
 *   - "直接报完成" / "假装通过" → 干掉 verification_closure skill 的核心约束
 *   - "默认为通过" → 鼓励默认 pass
 *
 * 注：测试层的 `expect(x).toPass()` 不在 blocklist——因为它是合法 jest/vitest API，
 * 误伤代价比发现攻击面更高。Prompt 级别的注入才是真正的威胁面。
 */
export const SKILL_CONTENT_BLOCKLIST_PATTERNS: ReadonlyArray<RegExp> = [
  /无需\s*读取/iu,
  /无需\s*读仓库/iu,
  /不需[要]?\s*读/iu,
  /凭[经验模板通用]/iu,
  /通用\s*经验/iu,
  /不用\s*验证/iu,
  /无需\s*验证/iu,
  /跳过\s*check/iu,
  /跳过\s*检查/iu,
  /直接\s*报完成/iu,
  /默认[为就]?\s*通过/iu,
  /假装\s*通过/iu,
];

/** 命中任一 blocklist 模式 → 返回首条命中的字符串（截断到 80 字，避免 error 信息爆炸）。 */
export function findBlockedPhrase(systemGuidance: ReadonlyArray<string>): string | null {
  for (const text of systemGuidance) {
    for (const re of SKILL_CONTENT_BLOCKLIST_PATTERNS) {
      if (re.test(text)) {
        return text.length > 80 ? `${text.slice(0, 77)}…` : text;
      }
    }
  }
  return null;
}
