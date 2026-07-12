/**
 * 引擎化改造方案 §7.2 K7 真强制 —— capability 的中立注册表。
 *
 * 这是 K7 enforcement 的"中立事实表"：tools 层（L6）和 skills 层（L7）都需要读，
 * 但都不能让另一方依赖。所以放在 lib/llm 下，跟 tools 平级，skills 通过 import 这个
 * （skills → lib/llm 当前规则允许）反向安全。
 *
 * 模块构成：
 *   - ALL_CAPABILITIES：capability 字符串常量表
 *   - capabilitiesForToolKind：tool.security.kind → 该工具链提供的 capability
 *   - enforceCapabilities：核心 check，skill 需求 ⊆ tool 能力才 ok
 *
 * 故意不放：content blocklist（SKILL_CONTENT_BLOCKLIST_PATTERNS）——这是 Skill 域专属
 * 治理词（防注入 prompt 注入退化诱导），跟 capability guard 解耦，留在 skills/capabilities.ts。
 */

export const ALL_CAPABILITIES = Object.freeze([
  "read_files",
  "edit_files",
  "inspect_git",
  "run_readonly_checks",
  "run_tests",
  "run_build",
  "inspect_failures",
  "update_docs",
  "run_commands",
  "ask_user",
  "web_fetch",
  "memory_store",
] as const);

export type Capability = (typeof ALL_CAPABILITIES)[number];

/** Tool security.kind → 该工具链提供的 capabilities。 */
export function capabilitiesForToolKind(
  kind: "read-path" | "write-path" | "command" | "none",
): ReadonlyArray<Capability> {
  switch (kind) {
    case "read-path":
      return ["read_files"];
    case "write-path":
      return ["edit_files"];
    case "command":
      return ["run_commands"];
    case "none":
      // ask_user / remember / web_fetch / web_search 这类工具有自家边界检查，
      // 跟 skill capability 正交——不通过 K7 enforcement 卡点。
      return [];
  }
}

export interface CapabilityCheck {
  ok: boolean;
  /** Skill 需要但工具不提供的 capability。 */
  missing: ReadonlyArray<string>;
  /** 给 UI/日志：缺的原因 + 未知 cap。 */
  reason: string;
}

/**
 * K7 真强制：skill 声明 requiredCapabilities，工具链提供 toolCaps；
 * skill 需求必须是 tool 提供集合的子集，否则不允许执行。
 *
 * 未在 ALL_CAPABILITIES 的 capability 字符串视为"schema 错误"——schema 校验应早拦，
 * 这是兜底；生产侧靠 registerSkill 的 zod 校验把关。
 */
export function enforceCapabilities(
  skillCaps: ReadonlyArray<string>,
  toolCaps: ReadonlyArray<string>,
): CapabilityCheck {
  const toolSet = new Set(toolCaps);
  const unknownCaps = skillCaps.filter(
    (c) => !(ALL_CAPABILITIES as readonly string[]).includes(c),
  );
  const missing = skillCaps.filter((c) => !toolSet.has(c));
  if (missing.length === 0 && unknownCaps.length === 0) {
    return { ok: true, missing: [], reason: "" };
  }
  const reasons: string[] = [];
  if (missing.length > 0) reasons.push(`tools lack: ${missing.join(", ")}`);
  if (unknownCaps.length > 0) reasons.push(`unknown capabilities: ${unknownCaps.join(", ")}`);
  return { ok: false, missing, reason: reasons.join("; ") };
}
