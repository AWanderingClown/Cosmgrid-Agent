import type { StructuredAcceptanceCriterion } from "./types";

/**
 * verify 阶段真实判定接入的验收标准（2026-07-14，Skill/Workflow 解耦后续步骤）。
 *
 * 内容迁移自原 lib/skills/registry.ts 的 verification_closure.acceptanceCriteria（那条
 * 已标记历史/待退休，不再改动），也是 lib/workflow/phase-guidance.ts verify 分支那句
 * "验收标准：..."文本提示描述的同一组检查——这是第一次让"给模型看的文字提示"和"驱动真实
 * 判定的结构化标准"指向同一个权威来源。
 *
 * 判定语义（见 structured-criteria.ts 三态改造）：tests_pass 严格（没有真实可核对的测试
 * 证据 = 判定失败）；typecheck_pass/lint_pass/build_pass 宽松（本轮没跑不算错，跑了但真
 * 失败才算错）。只在 stream-finalization.ts 里 currentNode.phase === "verify" 时传入。
 */
export const VERIFY_ACCEPTANCE_CRITERIA: StructuredAcceptanceCriterion[] = [
  { id: "tests_pass", description: "运行测试套件全部通过", kind: "test_run" },
  { id: "typecheck_pass", description: "tsc --noEmit 通过", kind: "typecheck" },
  { id: "lint_pass", description: "ESLint 无 error", kind: "lint" },
  { id: "build_pass", description: "构建无 error", kind: "build" },
];
