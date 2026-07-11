import type { SkillDefinition, SkillId } from "./types";

export const CORE_SKILLS: SkillDefinition[] = [
  {
    id: "project_audit",
    label: "项目审计",
    purpose: "读取真实项目状态，建立事实清单和缺口判断。",
    triggerPhases: ["read_project", "plan"],
    triggerKeywords: ["看项目", "读项目", "分析项目", "审计", "现状", "缺口", "问题"],
    requiredCapabilities: ["read_files", "inspect_git", "run_readonly_checks"],
    systemGuidance: [
      "先读取项目文件、配置、测试和文档，再下结论。",
      "区分已经验证的事实、合理推断和未知项。",
      "不要用模板化项目经验替代当前仓库的真实状态。",
    ],
    acceptanceCriteria: [
      "列出关键模块和真实缺口。",
      "指出下一步最小可执行切入点。",
      "没有读取依据的内容必须标成未确认。",
    ],
  },
  {
    id: "plan_execution",
    label: "按方案执行",
    purpose: "基于已确认方案直接落地，不重复进入方案讨论或博弈。",
    triggerPhases: ["execute"],
    triggerKeywords: ["开始执行", "按方案", "直接执行", "落地", "实现", "修复", "改代码"],
    requiredCapabilities: ["edit_files", "run_tests", "update_docs"],
    systemGuidance: [
      "执行前先确认当前方案来源，优先使用 workflow context 或桌面方案文件。",
      "用户要求执行时不要重新发起博弈，除非用户本轮明确要求博弈。",
      "每一段实现都要有真实文件改动或真实验证证据。",
    ],
    acceptanceCriteria: [
      "改动范围和方案目标一致。",
      "完成后运行相关测试或类型检查。",
      "如果验证失败，明确失败项和下一步修复点。",
    ],
  },
  {
    id: "verification_closure",
    label: "验证收口",
    purpose: "用真实检查收口，防止口头完成和未验证完成。",
    triggerPhases: ["verify"],
    triggerKeywords: ["验证", "测试", "构建", "typecheck", "lint", "跑一下", "检查"],
    requiredCapabilities: ["run_tests", "run_build", "inspect_failures"],
    systemGuidance: [
      "必须报告真实执行过的检查，不要把计划当结果。",
      "优先跑与本轮改动直接相关的测试，再跑类型检查或构建。",
      "发现失败时先定位原因，不要直接宣布完成。",
    ],
    // 阶段3（2026-07-11）：acceptanceCriteria 从 string[] 升级为结构化数组。
    // Task Verifier（lib/llm/evidence/task-verifier.ts）按 kind 调度具体 check 实现
    // （lib/llm/evidence/structured-criteria.ts）。registry.ts 只需声明 id+description+kind，
    // 不需要反向依赖 evidence 模块的运行时。
    acceptanceCriteria: [
      { id: "tests_pass", description: "运行测试套件全部通过", kind: "test_run" },
      { id: "typecheck_pass", description: "tsc --noEmit 通过", kind: "typecheck" },
      { id: "lint_pass", description: "ESLint 无 error", kind: "lint" },
      { id: "build_pass", description: "构建无 error", kind: "build" },
    ],
  },
];

export function getSkillDefinition(id: SkillId): SkillDefinition | null {
  return CORE_SKILLS.find((skill) => skill.id === id) ?? null;
}
