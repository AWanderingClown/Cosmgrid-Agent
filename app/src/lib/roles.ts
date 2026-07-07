// 团队角色词表——orchestrator (L10 编排层) 和 db (L0 状态层) 都要用同一套角色 id，
// 词表本身放中立位置，避免 L0 反向依赖 L10。orchestrator.ts 从这里 re-export，
// 其余既有消费者路径不用改。

/** 8 个团队角色（阶段 C 引入）。
 *  - leader:    团队 Leader / 编排者（粗活，便宜档；用户手选不覆盖）
 *  - architect: 方案 / 架构评审（精活，强模型）
 *  - frontend:  前端工程师
 *  - backend:   后端工程师
 *  - runner:    运行执行员（粗活，便宜；跑 build/lint/起服务）
 *  - tester:    测试工程师
 *  - reviewer:  审查工程师（强模型；只在用户明确说审查/复核/检查时才激活）
 *  - security:  安全工程师（强模型；只在用户明确要安全检查时激活）
 */
export const ROLE_IDS = [
  "leader",
  "architect",
  "frontend",
  "backend",
  "runner",
  "tester",
  "reviewer",
  "security",
] as const;
export type RoleId = (typeof ROLE_IDS)[number];
