import { RETIRED_BUILT_IN_TEMPLATE_NAMES } from "../templates";
import { ROLE_IDS, type RoleId } from "../llm/orchestrator";
import { getDb } from "./connection";
import { boolToInt, newId, now } from "./utils";

// ============ projectTemplates CRUD ============

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  isBuiltIn: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTemplateRole {
  id: string;
  templateId: string;
  workRole: string;
  modelId: string;
  fallbackModelId: string | null;
  order: number;
  systemPrompt: string | null;
  enabled: boolean;
}

interface ProjectTemplateRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  is_built_in: number;
  is_default: number;
  created_at: string;
  updated_at: string;
}

interface ProjectTemplateRoleRow {
  id: string;
  template_id: string;
  work_role: string;
  model_id: string;
  fallback_model_id: string | null;
  order: number;
  system_prompt: string | null;
  enabled: number;
}

function rowToProjectTemplate(r: ProjectTemplateRow): ProjectTemplate {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    icon: r.icon,
    isBuiltIn: r.is_built_in === 1,
    isDefault: r.is_default === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToProjectTemplateRole(r: ProjectTemplateRoleRow): ProjectTemplateRole {
  return {
    id: r.id,
    templateId: r.template_id,
    workRole: r.work_role,
    modelId: r.model_id,
    fallbackModelId: r.fallback_model_id,
    order: r.order,
    systemPrompt: r.system_prompt,
    enabled: r.enabled === 1,
  };
}

export interface CreateProjectTemplateInput {
  name: string;
  description?: string | null;
  icon?: string | null;
  isBuiltIn?: boolean;
  isDefault?: boolean;
}

export const projectTemplates = {
  async list(): Promise<ProjectTemplate[]> {
    const db = await getDb();
    const rows = await db.select<ProjectTemplateRow[]>(
      "SELECT * FROM project_templates ORDER BY is_built_in DESC, created_at ASC"
    );
    const retiredNames = new Set<string>(RETIRED_BUILT_IN_TEMPLATE_NAMES);
    return rows
      .map(rowToProjectTemplate)
      .filter((tpl) => !(tpl.isBuiltIn && retiredNames.has(tpl.name)));
  },

  async getById(id: string): Promise<ProjectTemplate | null> {
    const db = await getDb();
    const rows = await db.select<ProjectTemplateRow[]>(
      "SELECT * FROM project_templates WHERE id = $1",
      [id]
    );
    return rows[0] ? rowToProjectTemplate(rows[0]) : null;
  },

  async create(input: CreateProjectTemplateInput): Promise<ProjectTemplate> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO project_templates (id, name, description, icon, is_built_in, is_default, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        input.name,
        input.description ?? null,
        input.icon ?? null,
        boolToInt(input.isBuiltIn ?? false),
        boolToInt(input.isDefault ?? false),
        ts,
        ts,
      ]
    );
    return (await projectTemplates.getById(id))!;
  },

  async update(id: string, input: Partial<CreateProjectTemplateInput>): Promise<ProjectTemplate> {
    const db = await getDb();
    const ts = now();
    const sets: string[] = ["updated_at = $1"];
    const vals: unknown[] = [ts];
    let i = 2;
    if (input.name !== undefined) { sets.push(`name = $${i++}`); vals.push(input.name); }
    if (input.description !== undefined) { sets.push(`description = $${i++}`); vals.push(input.description); }
    if (input.icon !== undefined) { sets.push(`icon = $${i++}`); vals.push(input.icon); }
    if (input.isDefault !== undefined) { sets.push(`is_default = $${i++}`); vals.push(boolToInt(input.isDefault)); }
    vals.push(id);
    await db.execute(
      `UPDATE project_templates SET ${sets.join(", ")} WHERE id = $${i}`,
      vals
    );
    return (await projectTemplates.getById(id))!;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM project_templates WHERE id = $1", [id]);
  },
};

export interface CreateProjectTemplateRoleInput {
  templateId: string;
  workRole: string;
  modelId: string;
  fallbackModelId?: string | null;
  order?: number;
  systemPrompt?: string | null;
  enabled?: boolean;
}

export const projectTemplateRoles = {
  async listByTemplate(templateId: string): Promise<ProjectTemplateRole[]> {
    const db = await getDb();
    const rows = await db.select<ProjectTemplateRoleRow[]>(
      `SELECT * FROM project_template_roles WHERE template_id = $1 ORDER BY "order" ASC`,
      [templateId]
    );
    return rows.map(rowToProjectTemplateRole);
  },

  async create(input: CreateProjectTemplateRoleInput): Promise<ProjectTemplateRole> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      `INSERT INTO project_template_roles
        (id, template_id, work_role, model_id, fallback_model_id, "order", system_prompt, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        input.templateId,
        input.workRole,
        input.modelId,
        input.fallbackModelId ?? null,
        input.order ?? 0,
        input.systemPrompt ?? null,
        boolToInt(input.enabled ?? true),
      ]
    );
    const rows = await db.select<ProjectTemplateRoleRow[]>(
      "SELECT * FROM project_template_roles WHERE id = $1",
      [id]
    );
    return rowToProjectTemplateRole(rows[0]!);
  },

  async update(id: string, input: Partial<CreateProjectTemplateRoleInput>): Promise<ProjectTemplateRole> {
    const db = await getDb();
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (input.modelId !== undefined) { sets.push(`model_id = $${i++}`); vals.push(input.modelId); }
    if (input.fallbackModelId !== undefined) { sets.push(`fallback_model_id = $${i++}`); vals.push(input.fallbackModelId); }
    if (input.systemPrompt !== undefined) { sets.push(`system_prompt = $${i++}`); vals.push(input.systemPrompt); }
    if (input.enabled !== undefined) { sets.push(`enabled = $${i++}`); vals.push(boolToInt(input.enabled)); }
    vals.push(id);
    await db.execute(
      `UPDATE project_template_roles SET ${sets.join(", ")} WHERE id = $${i}`,
      vals
    );
    const rows = await db.select<ProjectTemplateRoleRow[]>(
      "SELECT * FROM project_template_roles WHERE id = $1",
      [id]
    );
    return rowToProjectTemplateRole(rows[0]!);
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM project_template_roles WHERE id = $1", [id]);
  },

  /** 阶段 D：从指定模板读"8 角色绑定"（workRole=RoleId 行）→ Map<RoleId, modelId>
   *  - 一列一义：只查 workRole IN ROLE_IDS 的行；老模板的 13 枚举 workRole 行不进 Map
   *  - enabled=false 的行不进 Map（用户禁用的角色不参与编排）
   *  - modelId 空/全空白不进 Map（用户没绑 = 不该塞个空绑定到 Map，编排 L2 会用空字符串查 availableModels 失败再走 L3 fallback——多走一步弯路；这里直接跳过更干净）
   *  - 返回 Map 而非 Record：调用方 resolveOrchestration 直接 roleBindings.get(role) 查
   *  - 纯函数；无 IO 副作用（除了 listByTemplate 的 SELECT）
   */
  async getRoleBindingsForTemplate(templateId: string): Promise<Map<RoleId, string>> {
    const rows = await this.listByTemplate(templateId);
    const map = new Map<RoleId, string>();
    const allowedRoles = new Set<string>(ROLE_IDS);
    for (const r of rows) {
      if (!allowedRoles.has(r.workRole)) continue; // 老 13 枚举 workRole 行跳过（一列一义）
      if (!r.enabled) continue; // 禁用的角色跳过
      if (!r.modelId || !r.modelId.trim()) continue; // 空字符串/全空白占位行跳过（不把空绑定塞进 Map——省编排 L2 多走一步 fallback）
      map.set(r.workRole as RoleId, r.modelId);
    }
    return map;
  },
};

// ============ projects CRUD（4.2 / 9 节：Project + ProjectStage） ============

export interface Project {
  id: string;
  name: string;
  description: string | null;
  templateId: string | null;
  currentStage: string;
  status: string;
  workspacePath: string | null;
  createdAt: string;
  updatedAt: string;
  template?: { name: string };
}

export interface ProjectStage {
  id: string;
  projectId: string;
  workRole: string;
  modelId: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  outputSummary: string | null;
  errorMessage: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  template_id: string | null;
  current_stage: string;
  status: string;
  workspace_path: string | null;
  created_at: string;
  updated_at: string;
  template_name?: string;
}

interface ProjectStageRow {
  id: string;
  project_id: string;
  work_role: string;
  model_id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  output_summary: string | null;
  error_message: string | null;
}

function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    templateId: r.template_id,
    currentStage: r.current_stage,
    status: r.status,
    workspacePath: r.workspace_path,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.template_name !== undefined && { template: { name: r.template_name } }),
  };
}

function rowToProjectStage(r: ProjectStageRow): ProjectStage {
  return {
    id: r.id,
    projectId: r.project_id,
    workRole: r.work_role,
    modelId: r.model_id,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    status: r.status,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cost: r.cost,
    outputSummary: r.output_summary,
    errorMessage: r.error_message,
  };
}

export interface CreateProjectInput {
  name: string;
  description?: string | null;
  templateId?: string | null;
  workspacePath?: string | null;
}

export const projects = {
  async list(): Promise<Project[]> {
    const db = await getDb();
    const rows = await db.select<ProjectRow[]>(`
      SELECT p.*, t.name AS template_name
      FROM projects p
      LEFT JOIN project_templates t ON p.template_id = t.id
      ORDER BY p.updated_at DESC
    `);
    return rows.map(rowToProject);
  },

  async getById(id: string): Promise<Project | null> {
    const db = await getDb();
    const rows = await db.select<ProjectRow[]>(
      "SELECT * FROM projects WHERE id = $1",
      [id]
    );
    return rows[0] ? rowToProject(rows[0]) : null;
  },

  async create(input: CreateProjectInput): Promise<Project> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO projects (id, name, description, template_id, current_stage, status, workspace_path, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'main_chat','pending',$5,$6,$7)`,
      [id, input.name, input.description ?? null, input.templateId ?? null, input.workspacePath ?? null, ts, ts]
    );
    // 模板里"角色→模型"的分配已经在模板创建时定下了，新建项目时直接照着模板的角色清单
    // 生成对应的阶段（否则阶段时间线永远是空的，对话/检查点/交接包都无从谈起）
    if (input.templateId) {
      const roles = await projectTemplateRoles.listByTemplate(input.templateId);
      for (const role of roles.filter((r) => r.enabled)) {
        await projectStages.create({
          projectId: id,
          workRole: role.workRole,
          modelId: role.modelId,
        });
      }
    }
    return (await projects.getById(id))!;
  },

  async update(
    id: string,
    input: Partial<CreateProjectInput> & { currentStage?: string; status?: string }
  ): Promise<Project> {
    const db = await getDb();
    const ts = now();
    const sets: string[] = ["updated_at = $1"];
    const vals: unknown[] = [ts];
    let i = 2;
    if (input.name !== undefined) { sets.push(`name = $${i++}`); vals.push(input.name); }
    if (input.description !== undefined) { sets.push(`description = $${i++}`); vals.push(input.description); }
    if (input.workspacePath !== undefined) { sets.push(`workspace_path = $${i++}`); vals.push(input.workspacePath); }
    if (input.currentStage !== undefined) { sets.push(`current_stage = $${i++}`); vals.push(input.currentStage); }
    if (input.status !== undefined) { sets.push(`status = $${i++}`); vals.push(input.status); }
    vals.push(id);
    await db.execute(
      `UPDATE projects SET ${sets.join(", ")} WHERE id = $${i}`,
      vals
    );
    return (await projects.getById(id))!;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM projects WHERE id = $1", [id]);
  },
};

export interface CreateProjectStageInput {
  projectId: string;
  workRole: string;
  modelId: string;
  status?: string;
}

export const projectStages = {
  async listByProject(projectId: string): Promise<ProjectStage[]> {
    const db = await getDb();
    const rows = await db.select<ProjectStageRow[]>(
      "SELECT * FROM project_stages WHERE project_id = $1 ORDER BY started_at ASC",
      [projectId]
    );
    return rows.map(rowToProjectStage);
  },

  async create(input: CreateProjectStageInput): Promise<ProjectStage> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO project_stages (id, project_id, work_role, model_id, started_at, status)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, input.projectId, input.workRole, input.modelId, ts, input.status ?? "pending"]
    );
    const rows = await db.select<ProjectStageRow[]>(
      "SELECT * FROM project_stages WHERE id = $1",
      [id]
    );
    return rowToProjectStage(rows[0]!);
  },

  async update(
    id: string,
    input: Partial<{
      status: string;
      completedAt: string | null;
      inputTokens: number;
      outputTokens: number;
      cost: number;
      outputSummary: string | null;
      errorMessage: string | null;
    }>
  ): Promise<ProjectStage> {
    const db = await getDb();
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (input.status !== undefined) { sets.push(`status = $${i++}`); vals.push(input.status); }
    if (input.completedAt !== undefined) { sets.push(`completed_at = $${i++}`); vals.push(input.completedAt); }
    if (input.inputTokens !== undefined) { sets.push(`input_tokens = $${i++}`); vals.push(input.inputTokens); }
    if (input.outputTokens !== undefined) { sets.push(`output_tokens = $${i++}`); vals.push(input.outputTokens); }
    if (input.cost !== undefined) { sets.push(`cost = $${i++}`); vals.push(input.cost); }
    if (input.outputSummary !== undefined) { sets.push(`output_summary = $${i++}`); vals.push(input.outputSummary); }
    if (input.errorMessage !== undefined) { sets.push(`error_message = $${i++}`); vals.push(input.errorMessage); }
    vals.push(id);
    await db.execute(
      `UPDATE project_stages SET ${sets.join(", ")} WHERE id = $${i}`,
      vals
    );
    const rows = await db.select<ProjectStageRow[]>(
      "SELECT * FROM project_stages WHERE id = $1",
      [id]
    );
    return rowToProjectStage(rows[0]!);
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM project_stages WHERE id = $1", [id]);
  },
};
