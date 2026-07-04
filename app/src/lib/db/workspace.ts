import { getDb } from "./connection";
import { boolToInt, newId, now } from "./utils";

// ============ debateSessions CRUD（v0.8 阶段5：多角色对弈） ============

export interface DebateRoundData {
  role: string;
  modelId: string;
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface DebateSessionRow {
  id: string;
  projectId: string | null;
  topic: string;
  status: string;
  quickMode: boolean;
  rounds: DebateRoundData[];
  finalSolution: string | null;
  createdAt: string;
  completedAt: string | null;
}

function mapDebateRow(r: any): DebateSessionRow {
  return {
    id: r.id,
    projectId: r.project_id,
    topic: r.topic,
    status: r.status,
    quickMode: !!r.quick_mode,
    rounds: JSON.parse(r.rounds || "[]"),
    finalSolution: r.final_solution,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

export const debateSessions = {
  /** 保存一场完成的对弈 */
  async create(input: {
    projectId?: string | null;
    topic: string;
    quickMode: boolean;
    rounds: DebateRoundData[];
    finalSolution: string;
    status?: string;
  }): Promise<string> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO debate_sessions
        (id, project_id, topic, status, quick_mode, rounds, final_solution, created_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id, input.projectId ?? null, input.topic, input.status ?? "completed",
        boolToInt(input.quickMode), JSON.stringify(input.rounds), input.finalSolution, ts, ts,
      ]
    );
    return id;
  },

  /** 列出历史对弈（最近在前） */
  async list(limit = 50): Promise<DebateSessionRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM debate_sessions ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
    return rows.map(mapDebateRow);
  },

  async getById(id: string): Promise<DebateSessionRow | null> {
    const db = await getDb();
    const rows = await db.select<any[]>("SELECT * FROM debate_sessions WHERE id = $1", [id]);
    return rows.length > 0 ? mapDebateRow(rows[0]) : null;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM debate_sessions WHERE id = $1", [id]);
  },
};

// ============ toolExecutions CRUD（v0.7 阶段4：工具执行审计） ============

export interface ToolExecutionRow {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  /** 2026-07-04 修复：这次工具调用真实归属的那条 assistant 消息 id。
   *  旧数据没有这一列（迁移补列后为 null）——UI 侧对 null 值仍走时间戳窗口兜底，
   *  不强制回填，避免对历史记录做不保真的猜测性归属。 */
  messageId: string | null;
  toolName: string;
  input: string;
  output: string;
  status: string;
  userConfirmed: boolean;
  reversible: boolean;
  durationMs: number;
  createdAt: string;
}

function mapToolExecRow(r: any): ToolExecutionRow {
  return {
    id: r.id,
    projectId: r.project_id,
    conversationId: r.conversation_id,
    messageId: r.message_id ?? null,
    toolName: r.tool_name,
    input: r.input,
    output: r.output,
    status: r.status,
    userConfirmed: !!r.user_confirmed,
    reversible: !!r.reversible,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
  };
}

export const toolExecutions = {
  async create(input: {
    projectId?: string | null;
    conversationId?: string | null;
    messageId?: string | null;
    toolName: string;
    input: string;
    output: string;
    status: string;
    userConfirmed?: boolean;
    reversible?: boolean;
    durationMs: number;
  }): Promise<string> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      `INSERT INTO tool_executions
        (id, project_id, conversation_id, message_id, tool_name, input, output, status,
         user_confirmed, reversible, duration_ms, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id, input.projectId ?? null, input.conversationId ?? null, input.messageId ?? null, input.toolName,
        input.input, input.output, input.status,
        boolToInt(input.userConfirmed ?? false), boolToInt(input.reversible ?? false),
        input.durationMs, now(),
      ]
    );
    return id;
  },

  /** 列出最近的工具执行（审计/侧边栏用） */
  async list(limit = 100): Promise<ToolExecutionRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM tool_executions ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
    return rows.map(mapToolExecRow);
  },

  async listByConversation(conversationId: string): Promise<ToolExecutionRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM tool_executions WHERE conversation_id = $1 ORDER BY created_at ASC",
      [conversationId]
    );
    return rows.map(mapToolExecRow);
  },
};

// ============ workspaceConfigs CRUD（v0.7 阶段4b：项目级工具安全配置） ============

export const workspaceConfigs = {
  /** 取项目的自定义命令黑名单（无配置返回空数组） */
  async getBlockedCommands(projectId: string): Promise<string[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT blocked_commands FROM workspace_configs WHERE project_id = $1",
      [projectId]
    );
    if (rows.length === 0) return [];
    try {
      return JSON.parse(rows[0].blocked_commands || "[]");
    } catch {
      return [];
    }
  },

  /** 设置项目的自定义命令黑名单 */
  async setBlockedCommands(projectId: string, blocked: string[]): Promise<void> {
    const db = await getDb();
    await db.execute(
      `INSERT INTO workspace_configs (project_id, blocked_commands, updated_at)
       VALUES ($1,$2,$3)
       ON CONFLICT(project_id) DO UPDATE SET blocked_commands = excluded.blocked_commands, updated_at = excluded.updated_at`,
      [projectId, JSON.stringify(blocked), now()]
    );
  },
};
