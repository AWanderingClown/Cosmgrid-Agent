import type { WorkflowPhase } from "./types";

/**
 * 工作流「阶段能力策略」：每个阶段允许模型碰哪类工具。
 *
 * 背景（2026-07-14 解耦第 0 步）：K7 能力门控原先从"被选中的 skill"的 requiredCapabilities
 * 取值。但那 3 个内置 "skill"（project_audit/plan_execution/verification_closure）本质是
 * 阶段行为策略，不是可复用 skill。把能力供给从 skill 迁到 phase：门控先跟 skill 系统脱钩，
 * 后续拆 skill 时写保护不会熄火。
 *
 * 数值刻意对齐原 3 个内置 skill 的 requiredCapabilities，保证纯解耦、零行为变化：
 *   - read_project / plan ← project_audit（读 + 只读命令，不给写）
 *   - execute            ← plan_execution（写 + 跑测试）
 *   - verify             ← verification_closure（跑命令，不给写）
 *   - review / debate    ← 原来无内置 skill 命中 → 空数组 → 不门控（与旧行为一致）
 *
 * 返回空数组 = 该阶段不做 K7 门控（executor 只在 caps.length > 0 时才卡）。
 * capability 词表见 lib/llm/capability-registry.ts ALL_CAPABILITIES；这里只用字符串，
 * 不反向依赖 lib/llm，保持 workflow 层干净。
 */
export function capabilitiesForPhase(phase: WorkflowPhase | null | undefined): string[] {
  switch (phase) {
    case "read_project":
    case "plan":
      return ["read_files", "inspect_git", "run_readonly_checks"];
    case "execute":
      return ["edit_files", "run_tests", "update_docs"];
    case "verify":
      return ["run_tests", "run_build", "inspect_failures"];
    case "review":
    case "debate":
    default:
      return [];
  }
}
