// Harness 工程实施计划 阶段5 — 上下文 Playbook 类型定义（pure types）。
//
// 设计动机：阶段 1-4 让 Harness 有门控 + 工具结构化 + 证据链 + 量化指标，但
// "上下文"还是临时压缩层。阶段 5 把项目上下文升级为可增量维护、可追溯、可纠错的用户资产。
//
// 三段式：
// - Generator（轨迹收集）→ memory_playbook_events 表（event sourcing 模式）
// - Reflector（提炼候选经验）→ PlaybookCandidate[]
// - Curator（去重 / 冲突 / 合并）→ CuratorDecision[]
// - context-assembler（检索 + 加权 + 截断）→ PlaybookItem[] 给上游 prompt 装配
//
// 关键不变量：
// - 增量更新不丢旧条目（supersede 链保留历史）
// - harmful_count 高的条目降权不静默删
// - 决策/偏好/lesson 默认 confirm（requireApprovalAsV2）
// - 高 confidence (≥0.95) + kind='context' 自动入
// - 摘要压缩失败不阻断 Playbook 写入（旁路 try/catch）
// - L10 边界：lib/llm/playbook 不允许反向依赖 pages/components 运行时

export type PlaybookStatus = "active" | "candidate" | "disputed" | "superseded" | "archived";

/** project_memories 表 v0.6 已有 5 列；阶段 5 加 9 列后完整形态 */
export interface PlaybookItem {
  id: string;                          // project_memories.id
  projectId: string;
  kind: "decision" | "lesson" | "context" | "preference" | "other";
  title: string;
  content: string;
  importance: number;                   // 0-100
  tags: string[];
  /** 阶段5 新增：来源类别（message / tool_output / checkpoint / summary / manual / legacy） */
  sourceKind: "message" | "tool_output" | "checkpoint" | "summary" | "manual" | "legacy";
  /** 阶段5 新增：来源 id（messageId / tool_execution_id / checkpoint_id 等） */
  sourceRef: string | null;
  /** 阶段5 新增：confidence 0-1，curator 决定是否 confirm 入选 */
  confidence: number;
  /** 阶段5 新增：active / candidate / disputed / superseded / archived */
  status: PlaybookStatus;
  helpfulCount: number;
  harmfulCount: number;
  lastUsedAt: string | null;
  supersedesId: string | null;
  evidenceRefsJson: string | null;
  createdAt: string;
  updatedAt: string;
}

/** memory_playbook_events 表 7 种事件类型 */
export type PlaybookEventKind =
  | "tool_success"
  | "tool_error"
  | "checkpoint_failed"
  | "summary_dropped"
  | "outcome_passed"
  | "outcome_failed"
  | "outcome_needs_user";

export interface PlaybookEvent {
  id: string;
  projectId: string;
  conversationId: string | null;
  messageId: string | null;
  kind: PlaybookEventKind;
  /** 序列化的事件内容（失败原因 / 摘要 keyDecisions / 等） */
  payloadJson: string;
  occurredAt: string;
  createdAt: string;
}

/** Reflector 输出（curator 入参） */
export interface PlaybookCandidate {
  id: string;                          // 临时 uuid
  kind: PlaybookItem["kind"];
  title: string;
  content: string;
  importance: number;
  tags: string[];
  sourceKind: PlaybookItem["sourceKind"];
  sourceRef: string;
  confidence: number;
  /** 反查 evidence 链：candidate 来自哪些 event */
  sourceEventIds: string[];
  /** 人类可读解释（curator.confirm 弹窗用） */
  reason: string;
}

/** Curator 决策动作 7 种 */
export type CuratorAction =
  | "create"
  | "supersede"
  | "update_helpful"
  | "update_harmful"
  | "mark_disputed"
  | "mark_archived"
  | "skip";

export interface CuratorDecision {
  action: CuratorAction;
  /** 目标 memory id（update_supersede / update_helpful / update_harmful / mark_disputed / mark_archived 用） */
  targetId?: string;
  /** 新建条目内容（create 用） */
  newItem?: Omit<PlaybookItem, "id" | "createdAt" | "updatedAt" | "helpfulCount" | "harmfulCount" | "lastUsedAt">;
  /** human-readable 解释，给 confirm 弹窗用 */
  reason: string;
  /** 是否需要用户 confirm（curator 在 requireApprovalAsV2 流程里走） */
  requiresConfirm: boolean;
}

/** context-assembler 检索入参 */
export interface AssemblePlaybookContextInput {
  projectId: string;
  /** 当前任务关键信息（用于 tags 加权） */
  taskKeywords: string[];
  /** 当前 workflow phase（read_project / plan / execute / verify） */
  phase?: "read_project" | "plan" | "review" | "debate" | "execute" | "verify";
  /** workspace 路径（用于 path 匹配加权） */
  workspacePath?: string;
  /** 输出总字符上限（默认 4000，与 fabrication-evidence 一致） */
  maxChars?: number;
}