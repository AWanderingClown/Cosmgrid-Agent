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
  {
    version: "202607130001-eval-cases",
    description:
      "Create harness_eval_cases table for the Eval Harness dashboard (阶段4). " +
      "Stores EvalCase definitions (id / task_set_id / fixture path / permission profile / allowed models / acceptance criteria / budget / tags).",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS harness_eval_cases (
          id TEXT PRIMARY KEY,
          task_set_id TEXT NOT NULL,
          name TEXT NOT NULL,
          fixture_path TEXT NOT NULL,
          permission_profile TEXT NOT NULL DEFAULT 'default',
          allowed_models TEXT NOT NULL DEFAULT '[]',
          acceptance_criteria TEXT NOT NULL DEFAULT '[]',
          budget_usd REAL NOT NULL DEFAULT 1.0,
          timeout_seconds INTEGER NOT NULL DEFAULT 300,
          tags TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_eval_cases_task_set ON harness_eval_cases(task_set_id)",
      );
    },
  },
  {
    version: "202607130002-eval-runs",
    description:
      "Create harness_eval_runs table — one row per eval run (harness_version / model_id / task_set_id / cost / retry / status / failure_kinds_json).",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS harness_eval_runs (
          id TEXT PRIMARY KEY,
          harness_version TEXT NOT NULL,
          model_id TEXT NOT NULL,
          task_set_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          total_cost_usd REAL NOT NULL DEFAULT 0,
          retry_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'running',
          artifact_json TEXT,
          failure_kinds_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_eval_runs_task_set ON harness_eval_runs(task_set_id, started_at DESC)",
      );
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_eval_runs_harness_version ON harness_eval_runs(harness_version)",
      );
    },
  },
  {
    version: "202607130003-eval-results",
    description:
      "Create harness_eval_results table — one row per (task × attempt) with passed / cost / latency / failure_code / graded_json.",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS harness_eval_results (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          attempt_index INTEGER NOT NULL DEFAULT 0,
          passed INTEGER,
          attempt_cost_usd REAL NOT NULL DEFAULT 0,
          attempt_latency_ms INTEGER NOT NULL DEFAULT 0,
          interventions_count INTEGER NOT NULL DEFAULT 0,
          failure_code TEXT,
          graded_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (run_id) REFERENCES harness_eval_runs(id) ON DELETE CASCADE
        )
      `);
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_eval_results_run ON harness_eval_results(run_id)",
      );
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_eval_results_task ON harness_eval_results(task_id, attempt_index)",
      );
    },
  },
  {
    version: "202607130004-task-outcomes",
    description:
      "Create task_outcomes table — production task final outcome (passed / failed / blocked / needs_user / cancelled) per conversation. " +
      "阶段4 11 个指标的 human_interventions / recovery_rate 直接从这张表聚合。",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS task_outcomes (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          node_id TEXT,
          outcome TEXT NOT NULL,
          final_summary TEXT,
          intervention_kind TEXT,
          evidence_refs_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_task_outcomes_conv ON task_outcomes(conversation_id, created_at DESC)",
      );
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_task_outcomes_outcome ON task_outcomes(outcome)",
      );
    },
  },
  {
    version: "202607130005-usage-events-latency",
    description:
      "Add latency_ms column to usage_events so latency_per_success metric is computable. " +
      "Reuses existing addColumnIfMissing pattern.",
    up: async (db) => {
      await addColumnIfMissing(db, "usage_events", "latency_ms", "INTEGER NOT NULL DEFAULT 0");
    },
  },
];
