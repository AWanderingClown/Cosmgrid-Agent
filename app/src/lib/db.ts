// 数据库层：tauri-plugin-sql 直连 SQLite
// 替代 server/db.ts + server/routes/factory.ts（Prisma + Hono）
// 所有 id 用 crypto.randomUUID()，Boolean 存 INTEGER，DateTime 存 TEXT ISO

import { BUILT_IN_TEMPLATES } from "./templates";
import { ROLE_IDS, type RoleId } from "./roles";
import { getDb } from "./db/connection";
import { conversations } from "./db/conversations";
import { projectTemplateRoles, projects } from "./db/projects";
import { initSchemaForDb } from "./db/schema";
import { newId, now } from "./db/utils";

export { getDb } from "./db/connection";
export { cliSessions, modelPriceCatalog, priceSyncStatus, savingsEvents } from "./db/billing";
export type {
  CliSessionRow,
  ModelPriceCatalogEntry,
  ModelPriceCatalogVersion,
  PriceSyncStatus,
  SavingsEventRow,
  SavingsEventSummary,
} from "./db/billing";
export { conversations } from "./db/conversations";
export type { Conversation, ConversationRow } from "./db/conversations";
export { workflowRuns } from "./db/workflow-runs";
export type { WorkflowEvent, WorkflowEventRow, WorkflowRun, WorkflowRunRow } from "./db/workflow-runs";
export { intentLearning } from "./db/intent-learning";
export type {
  IntentFeedbackEvent,
  IntentFeedbackEventRow,
  IntentExampleRow,
  StoredIntentExample,
} from "./db/intent-learning";
export { messages } from "./db/messages";
export type { DbMessage, MessageRow } from "./db/messages";
export { apiCredentials, models, providers } from "./db/resources";
export type {
  ApiCredential,
  CreateCredentialInput,
  CreateModelInput,
  CreateProviderInput,
  Model,
  Provider,
} from "./db/resources";
export { projectStages, projectTemplateRoles, projectTemplates, projects } from "./db/projects";
export type {
  CreateProjectInput,
  CreateProjectStageInput,
  CreateProjectTemplateInput,
  CreateProjectTemplateRoleInput,
  Project,
  ProjectStage,
  ProjectTemplate,
  ProjectTemplateRole,
} from "./db/projects";
export { tokenPlans } from "./db/token-plans";
export type { CreateTokenPlanInput, TokenPlan } from "./db/token-plans";
export { checkpoints } from "./db/checkpoints";
export type { Checkpoint, CreateCheckpointInput } from "./db/checkpoints";
export { handoffPackets, renderHandoffMarkdown } from "./db/handoff-packets";
export type { CreateHandoffPacketInput, HandoffPacket } from "./db/handoff-packets";
export { usageEvents } from "./db/usage-events";
export type { UsageEventRow } from "./db/usage-events";
export { modelPerformanceStats } from "./db/model-performance-stats";
export type { ModelPerformanceStatRow } from "./db/model-performance-stats";
export { semanticCache } from "./db/semantic-cache";
export type { SemanticCacheRow } from "./db/semantic-cache";
export { debateSessions, toolExecutions, workspaceConfigs } from "./db/workspace";
export type { DebateRoundData, DebateSessionRow, ToolExecutionRow } from "./db/workspace";
export {
  evalCases, evalRuns, evalResults, taskOutcomes,
} from "./db/evals";
export type {
  EvalCaseRow, EvalRunRow, EvalResultRow, TaskOutcomeRow, TaskOutcomeValue,
} from "./db/evals";
export { playbookEvents } from "./db/playbook-events";
export type { PlaybookEventRow } from "./db/playbook-events";
export { mcpServers, mcpServerApprovals } from "./db/mcp";
export type {
  CreateMcpServerInput,
  McpServerApprovalInput,
  McpServerRow,
  McpTransport,
  UpdateMcpServerInput,
} from "./db/mcp";
export { memoryKindLabel, projectMemories, projectMemoryVectors } from "./db/memory";
export { modelCooldowns } from "./db/model-cooldowns";
export { conversationSummaries } from "./db/conversation-summaries";
export type {
  ConversationSummary,
  CreateConversationSummaryInput,
} from "./db/conversation-summaries";
export type {
  CreateProjectMemoryInput,
  MemoryKind,
  ProjectMemory,
  ProjectMemoryVector,
  ProjectMemoryVectorSearchRow,
  SearchProjectMemoriesOptions,
} from "./db/memory";

/** 阶段 D：给指定会话查"8 角色绑定"。
 *  - 有 project → 查 project 的模板 → getRoleBindingsForTemplate
 *  - 无 project → 用"默认 8 角色"内置模板作兜底（ChatPage 主对话无 project 也能用角色绑定）
 *  - 查不到任何模板/绑定失败 → 返回空 Map（编排 fallback 自动选，原行为不变）
 *  - 单测可覆盖：mock dbConversations.getById 即可 */
export async function getRoleBindingsForConversation(convId: string): Promise<Map<RoleId, string>> {
  try {
    const conv = await conversations.getById(convId);
    let templateId: string | null = null;
    if (conv?.projectId) {
      const proj = await projects.getById(conv.projectId);
      templateId = proj?.templateId ?? null;
    }
    if (!templateId) {
      const db = await getDb();
      const rows = await db.select<Array<{ id: string }>>(
        'SELECT id FROM project_templates WHERE name = $1 AND is_built_in = 1 LIMIT 1',
        ['默认 8 角色'],
      );
      templateId = rows[0]?.id ?? null;
    }
    if (!templateId) return new Map();
    return projectTemplateRoles.getRoleBindingsForTemplate(templateId);
  } catch {
    return new Map();
  }
}

// ============ 建表 DDL（14 张，IF NOT EXISTS） ============

export async function initSchema(): Promise<void> {
  const db = await getDb();
  await initSchemaForDb(db);
}

// ============ 内置模板种子数据（4.13.3，只建模板本体，不建角色——角色模型由用户分配） ============

export async function seedBuiltInTemplates(): Promise<void> {
  const db = await getDb();
  // 用 ON CONFLICT DO NOTHING（基于 idx_project_templates_builtin_name 唯一索引）代替
  // “先查后插”：后者在并发调用下（如 React StrictMode 双触发 effect）会竞态产生重复行。
  for (const tpl of BUILT_IN_TEMPLATES) {
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO project_templates (id, name, description, icon, is_built_in, is_default, created_at, updated_at)
       VALUES ($1,$2,$3,$4,1,0,$5,$6)
       ON CONFLICT(name) WHERE is_built_in = 1 DO NOTHING`,
      [id, tpl.name, tpl.descriptionKey, tpl.icon, ts, ts]
    );
    // 阶段 D：给"默认 8 角色"内置模板额外 seed 8 条 RoleId 行（workRole=RoleId，modelId=null），
    // 让用户在 TemplatesPage 编辑后即生效。workRole=RoleId 一列一义，老模板 13 枚举 workRole 行不在 8 角色绑定路径里解释。
    if (tpl.workRoles.every((r) => (ROLE_IDS as readonly string[]).includes(r))) {
      await seedDefaultRoleRowsForTemplate(tpl.name);
    }
  }
}

/** 阶段 D 辅助：给"默认 8 角色"模板 seed 8 条 RoleId=workRole 行
 *  - model_id 用空字符串占位（schema 约束 NOT NULL，用户没绑前显示空下拉；getRoleBindingsForTemplate 看到空字符串 falsy 会跳过）
 *  - ON CONFLICT(template_id, work_role) DO NOTHING：已 seed 过的不重复插入
 *  - 仅写 workRole IN ROLE_IDS 的行；老 13 枚举 workRole 行不在此函数职责范围内 */
async function seedDefaultRoleRowsForTemplate(templateName: string): Promise<void> {
  const db = await getDb();
  const tplRows = await db.select<Array<{ id: string }>>(
    "SELECT id FROM project_templates WHERE name = $1 AND is_built_in = 1 LIMIT 1",
    [templateName],
  );
  const templateId = tplRows[0]?.id;
  if (!templateId) return;
  for (let i = 0; i < ROLE_IDS.length; i++) {
    const role = ROLE_IDS[i]!;
    await db.execute(
      `INSERT INTO project_template_roles (id, template_id, work_role, model_id, fallback_model_id, "order", system_prompt, enabled)
       VALUES ($1,$2,$3,'',NULL,$4,NULL,1)
       ON CONFLICT(template_id, work_role) DO NOTHING`,
      [newId(), templateId, role, i],
    );
  }
}
