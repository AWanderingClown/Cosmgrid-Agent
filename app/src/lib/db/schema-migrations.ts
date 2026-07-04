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
];
