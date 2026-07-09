import { getDb } from "./connection";
import { newId, now } from "./utils";

// ============ conversations CRUD ============

export interface ConversationRow {
  id: string;
  project_id: string | null;
  title: string;
  default_model_id: string | null;
  workspace_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  projectId: string | null;
  title: string;
  defaultModelId: string | null;
  /** 本地工作文件夹（AI 工具在此目录内读/改/跑命令）；未绑定为 null */
  workspacePath: string | null;
  createdAt: string;
  updatedAt: string;
}

// 单一映射出口：加字段时只改这里，杜绝多处 SELECT mapper 漏字段。
function mapConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    defaultModelId: r.default_model_id,
    workspacePath: r.workspace_path,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const conversations = {
  async list(): Promise<Conversation[]> {
    const db = await getDb();
    const rows = await db.select<ConversationRow[]>(
      "SELECT * FROM conversations WHERE archived_at IS NULL ORDER BY updated_at DESC"
    );
    return rows.map(mapConversation);
  },

  async create(input: { title: string; defaultModelId?: string | null; projectId?: string | null }): Promise<Conversation> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO conversations (id, project_id, title, default_model_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, input.projectId ?? null, input.title, input.defaultModelId ?? null, ts, ts]
    );
    const rows = await db.select<ConversationRow[]>("SELECT * FROM conversations WHERE id = $1", [id]);
    return mapConversation(rows[0]!);
  },

  // 主对话（无项目归属）的单例会话：取最近一条 project_id IS NULL 的会话，没有则建一条。
  // 让 ChatPage 主聊天像项目阶段对话一样落库，关 app 不丢上下文（产品真北：上下文是用户的资产）。
  async getOrCreateMainChat(defaultModelId?: string | null, title = "Main Chat"): Promise<Conversation> {
    const db = await getDb();
    const rows = await db.select<ConversationRow[]>(
      "SELECT * FROM conversations WHERE project_id IS NULL AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1"
    );
    const r = rows[0];
    if (r) {
      return mapConversation(r);
    }
    return this.create({ title, defaultModelId: defaultModelId ?? null, projectId: null });
  },

  // 列出全部主对话（无项目归属，未归档），最近活跃在前——ChatPage 多会话侧栏用。
  async listMainChats(): Promise<Conversation[]> {
    const db = await getDb();
    const rows = await db.select<ConversationRow[]>(
      "SELECT * FROM conversations WHERE project_id IS NULL AND archived_at IS NULL ORDER BY updated_at DESC"
    );
    return rows.map(mapConversation);
  },

  // 改标题（首条消息自动命名 / 用户手动重命名）。顺带 bump updated_at 让它排到最前。
  async rename(id: string, title: string): Promise<void> {
    const db = await getDb();
    await db.execute("UPDATE conversations SET title = $1, updated_at = $2 WHERE id = $3", [title, now(), id]);
  },

  // 用户手动切换顶部模型时，回写会话默认模型，保证重启后仍沿用用户最后一次选择。
  async setDefaultModelId(id: string, defaultModelId: string | null): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE conversations SET default_model_id = $1, updated_at = $2 WHERE id = $3",
      [defaultModelId, now(), id],
    );
  },

  // bump updated_at（有新消息时调，保证侧栏按最近活跃排序）。
  async touch(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("UPDATE conversations SET updated_at = $1 WHERE id = $2", [now(), id]);
  },

  // "删除"会话：每一段对话都是用户资产（对照 opencode 的 session.time_archived 做法），
  // 从不做真正的 DELETE——只打 archived_at 时间戳，list()/listMainChats() 按此过滤即可从
  // 列表消失。好处：不会有"删库失败但 UI 谎报删除成功"这种状态不一致，也不需要给
  // messages/tool_executions 等子表操心级联删除（父行始终还在，子表引用永远有效）。
  async archive(id: string): Promise<void> {
    const db = await getDb();
    const ts = now();
    await db.execute(
      "UPDATE conversations SET archived_at = $1, updated_at = $2 WHERE id = $3",
      [ts, ts, id],
    );
  },

  // 阶段 D：查单个会话（拿到 projectId，用于查模板 → 角色绑定）。没找到返 null。
  async getById(id: string): Promise<Conversation | null> {
    const db = await getDb();
    const rows = await db.select<ConversationRow[]>(
      "SELECT * FROM conversations WHERE id = $1 LIMIT 1",
      [id],
    );
    return rows[0] ? mapConversation(rows[0]) : null;
  },

  // 读编排者节点状态 JSON（没有则 null）。编排是后台锦上添花，列可能不存在的旧库已被 initSchema 迁移补上。
  async getOrchestration(id: string): Promise<string | null> {
    const db = await getDb();
    const rows = await db.select<Array<{ orchestration: string | null }>>(
      "SELECT orchestration FROM conversations WHERE id = $1",
      [id]
    );
    return rows[0]?.orchestration ?? null;
  },

  // 写编排者节点状态 JSON。故意不 bump updated_at——后台编排不该把会话顶到侧栏最前。
  async saveOrchestration(id: string, json: string): Promise<void> {
    const db = await getDb();
    await db.execute("UPDATE conversations SET orchestration = $1 WHERE id = $2", [json, id]);
  },

  // 绑定/解绑会话的本地工作文件夹（传 null 解绑）。不 bump updated_at——绑目录不算新消息。
  async setWorkspacePath(id: string, path: string | null): Promise<void> {
    const db = await getDb();
    await db.execute("UPDATE conversations SET workspace_path = $1 WHERE id = $2", [path, id]);
  },
};
