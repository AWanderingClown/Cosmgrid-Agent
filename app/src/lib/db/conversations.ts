import type { IntentRouteAction } from "../workflow/semantic-intent-router";
import type { WorkflowRunStatus, WorkflowSnapshot } from "../workflow/types";
import { getDb } from "./connection";
import { boolToInt, newId, now } from "./utils";

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

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  model_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  attachments: string | null;
  actor_role: string | null;
  chain_step_index: number | null;
  chain_step_total: number | null;
  chain_done: number | null;
  kind: string | null;
  created_at: string;
}

export interface DbMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  attachments?: string | null;
  actorRole?: string | null;
  chainStepIndex?: number | null;
  chainStepTotal?: number | null;
  chainDone?: boolean | null;
  kind?: string | null;
  createdAt: string;
}

function mapMessageRow(r: MessageRow): DbMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    modelId: r.model_id,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cost: r.cost,
    attachments: r.attachments,
    actorRole: r.actor_role,
    chainStepIndex: r.chain_step_index,
    chainStepTotal: r.chain_step_total,
    chainDone: r.chain_done === null ? null : r.chain_done === 1,
    kind: r.kind,
    createdAt: r.created_at,
  };
}

export const conversations = {
  async list(): Promise<Conversation[]> {
    const db = await getDb();
    const rows = await db.select<ConversationRow[]>(
      "SELECT * FROM conversations ORDER BY updated_at DESC"
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
      "SELECT * FROM conversations WHERE project_id IS NULL ORDER BY updated_at DESC LIMIT 1"
    );
    const r = rows[0];
    if (r) {
      return mapConversation(r);
    }
    return this.create({ title, defaultModelId: defaultModelId ?? null, projectId: null });
  },

  // 列出全部主对话（无项目归属），最近活跃在前——ChatPage 多会话侧栏用。
  async listMainChats(): Promise<Conversation[]> {
    const db = await getDb();
    const rows = await db.select<ConversationRow[]>(
      "SELECT * FROM conversations WHERE project_id IS NULL ORDER BY updated_at DESC"
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

  // 删除会话（messages 经 FK ON DELETE CASCADE 一并删）。
  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM conversations WHERE id = $1", [id]);
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

// ============ workflowRuns CRUD（v0.10：持久任务工作流） ============

export interface WorkflowRunRow {
  id: string;
  conversation_id: string;
  project_id: string | null;
  status: WorkflowRunStatus;
  current_phase: string | null;
  snapshot_json: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRun {
  id: string;
  conversationId: string;
  projectId: string | null;
  status: WorkflowRunStatus;
  currentPhase: string | null;
  snapshotJson: string;
  snapshot: WorkflowSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowEventRow {
  id: string;
  workflow_run_id: string;
  conversation_id: string;
  event_type: string;
  payload_json: string;
  created_at: string;
}

export interface WorkflowEvent {
  id: string;
  workflowRunId: string;
  conversationId: string;
  eventType: string;
  payloadJson: string;
  createdAt: string;
}

function currentPhaseOf(snapshot: WorkflowSnapshot): string | null {
  const node = snapshot.nodes.find((n) => n.id === snapshot.currentNodeId);
  return node?.phase ?? null;
}

function mapWorkflowRunRow(r: WorkflowRunRow): WorkflowRun {
  const snapshot = JSON.parse(r.snapshot_json) as WorkflowSnapshot;
  return {
    id: r.id,
    conversationId: r.conversation_id,
    projectId: r.project_id,
    status: r.status,
    currentPhase: r.current_phase,
    snapshotJson: r.snapshot_json,
    snapshot,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapWorkflowEventRow(r: WorkflowEventRow): WorkflowEvent {
  return {
    id: r.id,
    workflowRunId: r.workflow_run_id,
    conversationId: r.conversation_id,
    eventType: r.event_type,
    payloadJson: r.payload_json,
    createdAt: r.created_at,
  };
}

export const workflowRuns = {
  async create(input: {
    conversationId: string;
    projectId?: string | null;
    snapshot: WorkflowSnapshot;
  }): Promise<WorkflowRun> {
    const db = await getDb();
    const ts = now();
    const snapshotJson = JSON.stringify(input.snapshot);
    const currentPhase = currentPhaseOf(input.snapshot);
    await db.execute(
      `INSERT INTO workflow_runs
        (id, conversation_id, project_id, status, current_phase, snapshot_json, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.snapshot.runId,
        input.conversationId,
        input.projectId ?? input.snapshot.projectId ?? null,
        input.snapshot.status,
        currentPhase,
        snapshotJson,
        ts,
        ts,
      ],
    );
    await this.appendEvent({
      workflowRunId: input.snapshot.runId,
      conversationId: input.conversationId,
      eventType: "workflow.created",
      payload: { status: input.snapshot.status, currentPhase },
    });
    const rows = await db.select<WorkflowRunRow[]>("SELECT * FROM workflow_runs WHERE id = $1", [input.snapshot.runId]);
    return mapWorkflowRunRow(rows[0]!);
  },

  async getById(id: string): Promise<WorkflowRun | null> {
    const db = await getDb();
    const rows = await db.select<WorkflowRunRow[]>("SELECT * FROM workflow_runs WHERE id = $1 LIMIT 1", [id]);
    return rows[0] ? mapWorkflowRunRow(rows[0]) : null;
  },

  async getActiveByConversation(conversationId: string): Promise<WorkflowRun | null> {
    const db = await getDb();
    const rows = await db.select<WorkflowRunRow[]>(
      `SELECT * FROM workflow_runs
       WHERE conversation_id = $1 AND status IN ('running', 'waiting_user', 'paused')
       ORDER BY updated_at DESC
       LIMIT 1`,
      [conversationId],
    );
    return rows[0] ? mapWorkflowRunRow(rows[0]) : null;
  },

  async saveSnapshot(input: {
    runId: string;
    snapshot: WorkflowSnapshot;
    eventType?: string;
    eventPayload?: unknown;
  }): Promise<void> {
    const db = await getDb();
    const snapshotJson = JSON.stringify(input.snapshot);
    const currentPhase = currentPhaseOf(input.snapshot);
    const ts = now();
    await db.execute(
      `UPDATE workflow_runs
       SET status = $1, current_phase = $2, snapshot_json = $3, updated_at = $4
       WHERE id = $5`,
      [input.snapshot.status, currentPhase, snapshotJson, ts, input.runId],
    );
    if (input.eventType) {
      await this.appendEvent({
        workflowRunId: input.runId,
        conversationId: input.snapshot.conversationId,
        eventType: input.eventType,
        payload: input.eventPayload ?? { status: input.snapshot.status, currentPhase },
      });
    }
  },

  async appendEvent(input: {
    workflowRunId: string;
    conversationId: string;
    eventType: string;
    payload: unknown;
  }): Promise<string> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      `INSERT INTO workflow_events
        (id, workflow_run_id, conversation_id, event_type, payload_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, input.workflowRunId, input.conversationId, input.eventType, JSON.stringify(input.payload), now()],
    );
    return id;
  },

  async listEvents(workflowRunId: string): Promise<WorkflowEvent[]> {
    const db = await getDb();
    const rows = await db.select<WorkflowEventRow[]>(
      "SELECT * FROM workflow_events WHERE workflow_run_id = $1 ORDER BY created_at ASC",
      [workflowRunId],
    );
    return rows.map(mapWorkflowEventRow);
  },
};

// ============ intentLearning CRUD（v0.10：意图样例 + 用户纠错事件） ============

export interface IntentExampleRow {
  id: string;
  action: IntentRouteAction;
  text: string;
  explanation: string;
  source: "builtin" | "user_correction" | "accepted_decision";
  confidence: number;
  weight: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface StoredIntentExample {
  id: string;
  action: IntentRouteAction;
  text: string;
  explanation: string;
  source: "builtin" | "user_correction" | "accepted_decision";
  confidence: number;
  weight: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IntentFeedbackEventRow {
  id: string;
  user_text: string;
  predicted_action: IntentRouteAction;
  corrected_action: IntentRouteAction;
  workflow_state: string | null;
  source: "user_text" | "confirm_choice" | "manual_step" | "cancel_after_auto";
  reason: string | null;
  created_at: string;
}

export interface IntentFeedbackEvent {
  id: string;
  userText: string;
  predictedAction: IntentRouteAction;
  correctedAction: IntentRouteAction;
  workflowState: string | null;
  source: "user_text" | "confirm_choice" | "manual_step" | "cancel_after_auto";
  reason: string | null;
  createdAt: string;
}

function mapIntentExampleRow(r: IntentExampleRow): StoredIntentExample {
  return {
    id: r.id,
    action: r.action,
    text: r.text,
    explanation: r.explanation,
    source: r.source,
    confidence: Number(r.confidence),
    weight: Number(r.weight),
    enabled: Boolean(r.enabled),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapIntentFeedbackEventRow(r: IntentFeedbackEventRow): IntentFeedbackEvent {
  return {
    id: r.id,
    userText: r.user_text,
    predictedAction: r.predicted_action,
    correctedAction: r.corrected_action,
    workflowState: r.workflow_state,
    source: r.source,
    reason: r.reason,
    createdAt: r.created_at,
  };
}

export const intentLearning = {
  async upsertExample(input: {
    action: IntentRouteAction;
    text: string;
    explanation: string;
    source: "builtin" | "user_correction" | "accepted_decision";
    confidence?: number;
    weight?: number;
    enabled?: boolean;
  }): Promise<StoredIntentExample> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    const confidence = input.confidence ?? 0.8;
    const weight = input.weight ?? 1;
    const enabled = input.enabled ?? true;
    await db.execute(
      `INSERT INTO intent_examples
        (id, action, text, explanation, source, confidence, weight, enabled, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(action, text)
       DO UPDATE SET
         explanation = excluded.explanation,
         source = excluded.source,
         confidence = excluded.confidence,
         weight = excluded.weight,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      [
        id,
        input.action,
        input.text,
        input.explanation,
        input.source,
        confidence,
        weight,
        boolToInt(enabled),
        ts,
        ts,
      ],
    );
    const rows = await db.select<IntentExampleRow[]>(
      "SELECT * FROM intent_examples WHERE action = $1 AND text = $2 LIMIT 1",
      [input.action, input.text],
    );
    return mapIntentExampleRow(rows[0]!);
  },

  async listExamples(options: { enabledOnly?: boolean } = {}): Promise<StoredIntentExample[]> {
    const db = await getDb();
    const rows = await db.select<IntentExampleRow[]>(
      options.enabledOnly
        ? "SELECT * FROM intent_examples WHERE enabled = 1 ORDER BY updated_at DESC"
        : "SELECT * FROM intent_examples ORDER BY updated_at DESC",
    );
    return rows.map(mapIntentExampleRow);
  },

  async recordFeedback(input: {
    userText: string;
    predictedAction: IntentRouteAction;
    correctedAction: IntentRouteAction;
    workflowState?: string | null;
    source: "user_text" | "confirm_choice" | "manual_step" | "cancel_after_auto";
    reason?: string | null;
  }): Promise<string> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      `INSERT INTO intent_feedback_events
        (id, user_text, predicted_action, corrected_action, workflow_state, source, reason, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        input.userText,
        input.predictedAction,
        input.correctedAction,
        input.workflowState ?? null,
        input.source,
        input.reason ?? null,
        now(),
      ],
    );
    return id;
  },

  async listFeedbackEvents(): Promise<IntentFeedbackEvent[]> {
    const db = await getDb();
    const rows = await db.select<IntentFeedbackEventRow[]>(
      "SELECT * FROM intent_feedback_events ORDER BY created_at DESC",
    );
    return rows.map(mapIntentFeedbackEventRow);
  },

  // 2026-07-04 补：阶段3自我成长闭环的"降权"这一半（此前只有"纠正后加权"）。
  // 误判降权（导致一次错误判断的样例，权重打折）+ 长期不用衰减两条路径共用这两个方法。
  async updateExampleWeight(id: string, weight: number): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE intent_examples SET weight = $1, updated_at = $2 WHERE id = $3",
      [weight, now(), id],
    );
  },

  async setExampleEnabled(id: string, enabled: boolean): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE intent_examples SET enabled = $1, updated_at = $2 WHERE id = $3",
      [boolToInt(enabled), now(), id],
    );
  },
};

export const messages = {
  async listByConversation(conversationId: string): Promise<DbMessage[]> {
    const db = await getDb();
    const rows = await db.select<MessageRow[]>(
      "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
      [conversationId]
    );
    return rows.map(mapMessageRow);
  },

  async create(input: {
    conversationId: string;
    role: string;
    content: string;
    modelId?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    attachments?: string | null;
    actorRole?: string | null;
    chainStepIndex?: number | null;
    chainStepTotal?: number | null;
    chainDone?: boolean | null;
    kind?: string | null;
  }): Promise<DbMessage> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO messages
        (id, conversation_id, role, content, model_id, input_tokens, output_tokens, cost, attachments,
         actor_role, chain_step_index, chain_step_total, chain_done, kind, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id,
        input.conversationId,
        input.role,
        input.content,
        input.modelId ?? null,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        input.cost ?? 0,
        input.attachments ?? null,
        input.actorRole ?? null,
        input.chainStepIndex ?? null,
        input.chainStepTotal ?? null,
        input.chainDone === undefined || input.chainDone === null ? null : boolToInt(input.chainDone),
        input.kind ?? null,
        ts,
      ]
    );
    const rows = await db.select<MessageRow[]>("SELECT * FROM messages WHERE id = $1", [id]);
    return mapMessageRow(rows[0]!);
  },

  async updateChainMessage(id: string, input: {
    content?: string;
    chainDone?: boolean | null;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    modelId?: string | null;
  }): Promise<DbMessage | null> {
    const db = await getDb();
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (input.content !== undefined) { sets.push(`content = $${i++}`); vals.push(input.content); }
    if (input.chainDone !== undefined) { sets.push(`chain_done = $${i++}`); vals.push(input.chainDone === null ? null : boolToInt(input.chainDone)); }
    if (input.inputTokens !== undefined) { sets.push(`input_tokens = $${i++}`); vals.push(input.inputTokens); }
    if (input.outputTokens !== undefined) { sets.push(`output_tokens = $${i++}`); vals.push(input.outputTokens); }
    if (input.cost !== undefined) { sets.push(`cost = $${i++}`); vals.push(input.cost); }
    if (input.modelId !== undefined) { sets.push(`model_id = $${i++}`); vals.push(input.modelId); }
    if (sets.length === 0) {
      const rows = await db.select<MessageRow[]>("SELECT * FROM messages WHERE id = $1", [id]);
      return rows[0] ? mapMessageRow(rows[0]) : null;
    }
    vals.push(id);
    await db.execute(`UPDATE messages SET ${sets.join(", ")} WHERE id = $${i}`, vals);
    const rows = await db.select<MessageRow[]>("SELECT * FROM messages WHERE id = $1", [id]);
    return rows[0] ? mapMessageRow(rows[0]) : null;
  },
};
