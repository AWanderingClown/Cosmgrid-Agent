import { addColumnIfMissing, type SchemaMigration } from "../db-migrations";

export const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    version: "202607010001-conversation-orchestration-workspace",
    description: "Add orchestration and workspace path to conversations",
    up: async (db) => {
      await addColumnIfMissing(db, "conversations", "orchestration", "TEXT");
      await addColumnIfMissing(db, "conversations", "workspace_path", "TEXT");
    },
  },
  {
    version: "202607010002-message-attachments-chain-kind",
    description: "Add message attachments, chain metadata, and message kind",
    up: async (db) => {
      await addColumnIfMissing(db, "messages", "attachments", "TEXT");
      await addColumnIfMissing(db, "messages", "actor_role", "TEXT");
      await addColumnIfMissing(db, "messages", "chain_step_index", "INTEGER");
      await addColumnIfMissing(db, "messages", "chain_step_total", "INTEGER");
      await addColumnIfMissing(db, "messages", "chain_done", "INTEGER");
      await addColumnIfMissing(db, "messages", "kind", "TEXT");
    },
  },
  {
    version: "202607010003-usage-event-routing-pricing",
    description: "Add usage outcome, role kind, conversation, and pricing metadata",
    up: async (db) => {
      await addColumnIfMissing(db, "usage_events", "outcome", "TEXT");
      await addColumnIfMissing(db, "usage_events", "role_kind", "TEXT");
      await addColumnIfMissing(db, "usage_events", "conversation_id", "TEXT");
      await addColumnIfMissing(db, "usage_events", "pricing_known", "INTEGER NOT NULL DEFAULT 1");
      await addColumnIfMissing(db, "usage_events", "price_version", "TEXT");
      await addColumnIfMissing(db, "usage_events", "price_source", "TEXT");
      await addColumnIfMissing(db, "usage_events", "price_catalog_id", "TEXT");
    },
  },
  {
    version: "202607010004-semantic-cache-provider",
    description: "Add semantic cache provider name",
    up: async (db) => {
      await addColumnIfMissing(db, "semantic_cache", "provider_name", "TEXT NOT NULL DEFAULT 'keyword-hash'");
    },
  },
  {
    version: "202607010005-savings-price-catalog-links",
    description: "Add price catalog references to savings events",
    up: async (db) => {
      await addColumnIfMissing(db, "savings_events", "actual_price_catalog_id", "TEXT");
      await addColumnIfMissing(db, "savings_events", "baseline_price_catalog_id", "TEXT");
    },
  },
  {
    version: "202607040001-tool-execution-message-id",
    description: "Add message_id to tool_executions so UI can attribute a tool call to its exact message instead of guessing by timestamp window",
    up: async (db) => {
      await addColumnIfMissing(db, "tool_executions", "message_id", "TEXT");
    },
  },
  {
    version: "202607040002-conversation-archived-at",
    description: "Add archived_at to conversations — delete is now soft (archive), never a real DELETE, so orphaned child rows and 'undo by reinstalling' confusion can't happen",
    up: async (db) => {
      await addColumnIfMissing(db, "conversations", "archived_at", "TEXT");
    },
  },
  {
    version: "202607040003-message-tool-call-count",
    description:
      "Add tool_call_count to messages so the next turn can be told 'your last reply made 0 real tool calls' instead of letting the model guess (and confabulate) what it actually did",
    up: async (db) => {
      await addColumnIfMissing(db, "messages", "tool_call_count", "INTEGER");
    },
  },
  {
    version: "202607090001-mcp-secret-credential",
    description: "Store only an OS-keychain credential reference for MCP headers and environment secrets",
    up: async (db) => {
      await addColumnIfMissing(db, "mcp_servers", "secret_credential_id", "TEXT");
    },
  },
  {
    version: "202607110001-tool-execution-result-v2",
    description:
      "Add result_json to tool_executions so we can persist the structured ToolResultV2 " +
      "(status/summary/artifacts/nextActions/error) alongside the legacy status/output columns. " +
      "Old rows keep working: result_json is NULL, read path falls back to compatFromLegacy.",
    up: async (db) => {
      await addColumnIfMissing(db, "tool_executions", "result_json", "TEXT");
    },
  },
  {
    version: "202607110002-tool-execution-error-code",
    description:
      "Add error_code to tool_executions so UI/queries can filter by stable error taxonomy " +
      "(TOOL_DENIED/TOOL_TIMEOUT/TOOL_DOOM_LOOP/etc) without parsing result_json. " +
      "Indexed for the eval harness dashboard (阶段4 will read this).",
    up: async (db) => {
      await addColumnIfMissing(db, "tool_executions", "error_code", "TEXT");
      await addColumnIfMissing(db, "tool_executions", "warning_count", "INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    version: "202607110003-tool-execution-msg-error-index",
    description:
      "Add idx_tool_executions_message and idx_tool_executions_error_code indexes. " +
      "阶段1 引入 listByMessage(messageId) 在 stream-finalization 每次 finalize 都查一次， " +
      "没索引就全表扫；阶段2 新增 error_code 列也被阶段4 eval dashboard 用作过滤字段， " +
      "同样需要索引。",
    up: async (db) => {
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_tool_executions_message ON tool_executions(message_id) WHERE message_id IS NOT NULL",
      );
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_tool_executions_error_code ON tool_executions(error_code) WHERE error_code IS NOT NULL",
      );
    },
  },
  {
    version: "202607120001-evidence-store",
    description:
      "Create workflow_evidence table for storing EvidenceRef entries (阶段3 evidence chain). " +
      "阶段3 UI 只读 WorkflowSnapshot.outputs.verification（已通过 saveSnapshot 序列化），" +
      "workflow_evidence 表是 schema 预留，给未来的证据回放 UI 用；阶段3 不强制写入。",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS workflow_evidence (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('tool_execution','artifact','user_confirmation','structured_criterion')),
          source TEXT NOT NULL,
          summary TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          tool_execution_id TEXT,
          truncated INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_workflow_evidence_run ON workflow_evidence(run_id, node_id)",
      );
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_workflow_evidence_tool ON workflow_evidence(tool_execution_id)",
      );
    },
  },
];
