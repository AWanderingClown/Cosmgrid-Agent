/**
 * Skill 注册流程（阶段 1b §4.3 / §6）。
 *
 * 三道闸（K12 默认组合）：
 *   1. 数量上限（policy/上限）：user/ops 已注册技能 ≤ MAX_USER_SKILLS
 *   2. 内容黑名单词（capabilities.findBlockedPhrase）：命中任意"无需读取/凭经验/跳过 check"
 *      等退化诱导词 → 拒绝
 *   3. 来源标注 + 审核默认组合：用户注册默认 review_status='pending'，需要显式 approve
 *      才进 selector 装载集合。
 *
 * design：
 *   - registerSkill() 业务入口
 *   - approveSkill() / rejectSkill() 审核入口
 *   - 所有变更写 skill_audit_log + 改 skill_definitions
 *   - 异常用 SkillRegistrationError 抛，含 code 给 UI 文案
 *
 * ⚠️ 2026-07-14 重要提醒（workflow/skill 解耦第 0 步之后）：这里注册/审核的
 * requiredCapabilities 字段**不再参与 K7 执行期门控**——门控现在完全由当前工作流阶段
 * （lib/workflow/phase-capabilities.ts）决定，跟被选中的 skill 声明了什么无关。
 * 也就是说，本文件这套注册+审核流程目前只保证"内容不含退化诱导词 + 数量受限"，
 * 不再保证"审核通过的 skill 运行时工具权限被收窄到它声明的范围"。这个字段目前是
 * 展示性的，不是安全边界；详见 registerSkill() 里 EMPTY_REQUIRED_CAPABILITIES 校验旁的说明。
 */

import { z } from "zod";
import { skillDefinitions } from "@/lib/db/skill-definitions";
import { skillAuditLog } from "@/lib/db/skill-audit-log";
import { findBlockedPhrase } from "./capabilities";
import type { SkillReviewStatus, SkillSource } from "./types";

/** 来源是 user/ops 时已注册（pending+approved）的最大数量。 */
export const MAX_USER_SKILLS = 12;

export type SkillRegistrationErrorCode =
  | "QUOTA_EXCEEDED"
  | "BLOCKED_CONTENT"
  | "INVALID_SCHEMA"
  | "DUPLICATE_ID"
  | "EMPTY_REQUIRED_CAPABILITIES"
  | "UNKNOWN_ERROR";

export class SkillRegistrationError extends Error {
  public readonly code: SkillRegistrationErrorCode;
  /** 出错时附带的元数据（给 UI 用：哪个词被 block、当前计数等）。 */
  public readonly meta?: Record<string, unknown>;

  constructor(
    message: string,
    code: SkillRegistrationErrorCode,
    meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SkillRegistrationError";
    this.code = code;
    this.meta = meta;
  }
}

/** zod schema 用于校验 DB value_json 反序列化。builtin seed 也走这个 schema。 */
export const skillDefinitionJsonSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  purpose: z.string().min(1).max(2000),
  triggerPhases: z.array(z.string()),
  triggerKeywords: z.array(z.string()),
  requiredCapabilities: z.array(z.string()),
  systemGuidance: z.array(z.string()),
  acceptanceCriteria: z.array(z.unknown()),
});

/** builtin seed 跟注册共用，但 builtin 强制 review_status='approved' 且不查 content blocklist。 */
function isBuiltinSource(source: SkillSource): boolean {
  return source === "builtin";
}

/**
 * 注册一个新 skill。业务侧闸：
 *   - zod schema 校验 schema 正确
 *   - user/ops 来源查数量上限
 *   - systemGuidance 任意条目命中 blocklist 词 → 拒绝（K12 兜底）
 *   - builtin 来源跳过这些闸（源码编辑路径，无 content 风险）
 *
 * 写入：skillDefinitions.upsert + skillAuditLog.register
 * 返回：新建行的 id（与传入一致）。
 */
export async function registerSkill(input: {
  id: string;
  source: SkillSource;
  label: string;
  purpose: string;
  triggerPhases: ReadonlyArray<string>;
  triggerKeywords: ReadonlyArray<string>;
  requiredCapabilities: ReadonlyArray<string>;
  systemGuidance: ReadonlyArray<string>;
  acceptanceCriteria: ReadonlyArray<unknown>;
  actor?: string;
}): Promise<string> {
  // zod 校验
  const parsed = skillDefinitionJsonSchema.safeParse({
    id: input.id,
    label: input.label,
    purpose: input.purpose,
    triggerPhases: [...input.triggerPhases],
    triggerKeywords: [...input.triggerKeywords],
    requiredCapabilities: [...input.requiredCapabilities],
    systemGuidance: [...input.systemGuidance],
    acceptanceCriteria: [...input.acceptanceCriteria],
  });
  if (!parsed.success) {
    throw new SkillRegistrationError(
      `Skill schema 校验失败：${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      "INVALID_SCHEMA",
      { issues: parsed.error.issues },
    );
  }

  // ⚠️ 2026-07-14 事实更正（workflow/skill 解耦第 0 步之后）：下面这段校验保留，但下面
  // 这句"空 caps 会放过一切工具调用"描述的是解耦前的旧行为，现在已经不成立——
  // K7 的 activeCaps 完全来自当前工作流阶段（lib/workflow/phase-capabilities.ts），
  // 不再读任何 skill 的 requiredCapabilities。也就是说：不管这里注册的 skill 声明了什么
  // capability（包括这条 EMPTY_REQUIRED_CAPABILITIES 校验拦下的空数组），它对"这个 skill
  // 被选中时能不能写文件/跑命令"没有任何实际约束力——真正决定权限的是当前 workflow phase。
  // 校验本身继续保留是好事（schema 完整性、非空约束仍值得强制），但审核者/未来读这段代码的人
  // 不要误以为"审核通过 = 这个 skill 的工具权限被强制收窄"，那个保证目前不存在。
  // K7 真强制配套：requiredCapabilities 必须非空数组（历史校验，语义见上）。
  if (!Array.isArray(input.requiredCapabilities) || input.requiredCapabilities.length === 0) {
    throw new SkillRegistrationError(
      "Skill 必须声明至少一个 requiredCapabilities；空数组等于不约束，等于绕过 K7 enforcement",
      "EMPTY_REQUIRED_CAPABILITIES",
      { id: input.id },
    );
  }
  // 进一步：每个 capability 必须在 ALL_CAPABILITIES 里（schema 已粗检，但显式 reject 给清晰错误）。
  const allCaps = (await import("@/lib/llm/capability-registry")).ALL_CAPABILITIES as ReadonlyArray<string>;
  const unknownCaps = input.requiredCapabilities.filter((c) => !allCaps.includes(c));
  if (unknownCaps.length > 0) {
    throw new SkillRegistrationError(
      `Skill 声明了未注册的 capability：${unknownCaps.join(", ")}。请检查拼写或先在 ALL_CAPABILITIES 注册。`,
      "INVALID_SCHEMA",
      { unknown: unknownCaps },
    );
  }

  // 已存在 ID：拒绝
  const existing = await skillDefinitions.getById(input.id);
  if (existing) {
    throw new SkillRegistrationError(
      `Skill id "${input.id}" 已存在`,
      "DUPLICATE_ID",
      { id: input.id },
    );
  }

  // builtin 来源：跳过 content + 数量上限检查（来自源码，受代码审查保护）。
  if (!isBuiltinSource(input.source)) {
    // 数量上限
    const current = await skillDefinitions.countBySource(input.source);
    if (current >= MAX_USER_SKILLS) {
      throw new SkillRegistrationError(
        `${input.source} 类技能已达上限（${MAX_USER_SKILLS}）。请先 retire 不再使用的技能。`,
        "QUOTA_EXCEEDED",
        { source: input.source, current, max: MAX_USER_SKILLS },
      );
    }
    // content blocklist
    const blocked = findBlockedPhrase(input.systemGuidance);
    if (blocked) {
      throw new SkillRegistrationError(
        `系统提示包含退化诱导词："${blocked}"。这会让 skill 旁路 Harness 真实性保护，禁止注册。`,
        "BLOCKED_CONTENT",
        { blocked },
      );
    }
  }

  const reviewStatus: SkillReviewStatus = isBuiltinSource(input.source) ? "approved" : "pending";
  const ts = new Date().toISOString();
  await skillDefinitions.upsert({
    id: input.id,
    builtinVersion: isBuiltinSource(input.source) ? "builtin-2026-07-12" : null,
    label: input.label,
    purpose: input.purpose,
    triggerPhases: input.triggerPhases,
    triggerKeywords: input.triggerKeywords,
    requiredCapabilities: input.requiredCapabilities,
    systemGuidance: input.systemGuidance,
    acceptanceCriteria: input.acceptanceCriteria,
    source: input.source,
    reviewStatus,
    reviewedBy: isBuiltinSource(input.source) ? "builtin-seed" : null,
    reviewedAt: isBuiltinSource(input.source) ? ts : null,
  });
  await skillAuditLog.record({
    skillId: input.id,
    action: "register",
    actor: input.actor ?? null,
    notes: isBuiltinSource(input.source)
      ? "builtin seed"
      : `pending review; source=${input.source}`,
  });
  return input.id;
}

export async function approveSkill(id: string, reviewer: string, notes?: string): Promise<void> {
  const before = await skillDefinitions.getById(id);
  if (!before) {
    throw new SkillRegistrationError(`Skill id "${id}" 不存在`, "UNKNOWN_ERROR", { id });
  }
  await skillDefinitions.approve(id, reviewer);
  await skillAuditLog.record({
    skillId: id,
    action: "approve",
    actor: reviewer,
    notes: notes ?? null,
    diffJson: JSON.stringify({ from: before.reviewStatus, to: "approved" }),
  });
}

export async function rejectSkill(id: string, reviewer: string, notes?: string): Promise<void> {
  const before = await skillDefinitions.getById(id);
  if (!before) {
    throw new SkillRegistrationError(`Skill id "${id}" 不存在`, "UNKNOWN_ERROR", { id });
  }
  await skillDefinitions.reject(id, reviewer);
  await skillAuditLog.record({
    skillId: id,
    action: "reject",
    actor: reviewer,
    notes: notes ?? null,
    diffJson: JSON.stringify({ from: before.reviewStatus, to: "rejected" }),
  });
}

export async function retireSkill(id: string, actor: string, notes?: string): Promise<void> {
  const before = await skillDefinitions.getById(id);
  if (!before) return;
  await skillDefinitions.retire(id);
  await skillAuditLog.record({
    skillId: id,
    action: "retire",
    actor,
    notes: notes ?? null,
  });
}
