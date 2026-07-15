import type { WorkflowPhase } from "./types";

/**
 * 工作流阶段行为纪律（2026-07-14 从 lib/skills/registry.ts 的 3 个"伪 skill" 迁移而来）。
 *
 * 背景：project_audit / plan_execution / verification_closure 曾以 "skill" 的形式存在，
 * 但它们的触发条件是 triggerPhases（工作流阶段），不是任务相关性——本质是"给定当前阶段该
 * 怎么干"的行为纪律，不是可复用能力包。真 skill（.claude/skills 下每个子目录的 SKILL.md）
 * 已独立落地（见 claude-code-compat/skill-loader.ts），这里把原来 3 条的 systemGuidance/acceptanceCriteria
 * 文本原样迁移进工作流，不再经过 skill 选择机制（selector.ts 已把这 3 个内置 id 从选择候选里
 * 排除，避免同一段内容通过两条路径重复注入 prompt）。
 *
 * 迁移原则（架构评审定的边界）：这里的文本只讲"给定当前阶段该怎么做"，不引用 skill 概念，
 * 也不该被要求脱离工作流状态独立成立——这正是它们不是真 skill 的原因。
 *
 * 注意：verification_closure 原有的**结构化**验收标准（tests_pass/typecheck_pass/lint_pass/
 * build_pass，真正驱动 verifyTask 判定通过/失败、并能触发打回 execute 重做）不在本文件——
 * 这里只放纯文本纪律。结构化判定的权威定义 + 三态语义见 lib/llm/evidence/
 * verify-acceptance-criteria.ts + structured-criteria.ts；接入真门控（fails 触发
 * retryable/blocked，复用 MAX_REPAIR_ATTEMPTS 上限）见 stream-finalization.ts +
 * node-verifier.ts 的 applyVerifyRepairLoop（2026-07-14 已接入，不再是"未接入"状态）。
 */
export function guidanceForPhase(phase: WorkflowPhase | null | undefined): string[] {
  switch (phase) {
    case "read_project":
    case "plan":
      // 原 project_audit
      return [
        "先读取项目文件、配置、测试和文档，再下结论。",
        "区分已经验证的事实、合理推断和未知项。",
        "不要用模板化项目经验替代当前仓库的真实状态。",
        "验收标准：列出关键模块和真实缺口；指出下一步最小可执行切入点；没有读取依据的内容必须标成未确认。",
      ];
    case "execute":
      // 原 plan_execution + 迁移前已存在于 execution-context.ts 的独立执行阶段提醒（合并去重）
      return [
        "先对齐方案来源，优先使用 workflow context 或桌面方案文件；再改代码。",
        "阶段检查只是执行过程的一部分，不要每个阶段都停下来等用户确认；用户要求执行时不要重新发起博弈，除非本轮明确要求博弈。",
        "每一段实现都要有真实文件改动或真实验证证据。",
        "执行完成后继续验证，除非遇到权限、安全、范围或构建测试阻塞。",
        "验收标准：改动范围和方案目标一致；完成后运行相关测试或类型检查；如果验证失败，明确失败项和下一步修复点。",
      ];
    case "verify":
      // 原 verification_closure。这里的"验收标准"是原 acceptanceCriteria 的纯文本描述
      // （给模型看的提示）；真正驱动通过/失败判定 + 重试的结构化逻辑见文件头注释。
      return [
        "必须报告真实执行过的检查，不要把计划当结果。",
        "优先跑与本轮改动直接相关的测试，再跑类型检查或构建。",
        "发现失败时先定位原因，不要直接宣布完成。",
        "验收标准：运行测试套件全部通过；tsc --noEmit 通过；ESLint 无 error；构建无 error。",
      ];
    case "review":
    case "debate":
    default:
      return [];
  }
}
