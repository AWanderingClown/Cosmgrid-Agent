export interface DatabaseLike {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  select<T>(sql: string, params?: unknown[]): Promise<T>;
}

export interface SchemaMigration {
  version: string;
  description: string;
  up(db: DatabaseLike): Promise<void>;
}

/** SQLite 没有 ADD COLUMN IF NOT EXISTS，用 PRAGMA 做幂等补列。 */
export async function addColumnIfMissing(
  db: DatabaseLike,
  table: string,
  column: string,
  decl: string,
): Promise<void> {
  const cols = await db.select<Array<{ name: string }>>(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

async function ensureMigrationTable(db: DatabaseLike): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  await addColumnIfMissing(db, "schema_migrations", "status", "TEXT NOT NULL DEFAULT 'applied'");
  await addColumnIfMissing(db, "schema_migrations", "error_message", "TEXT");
  await addColumnIfMissing(db, "schema_migrations", "started_at", "TEXT");
  await addColumnIfMissing(db, "schema_migrations", "finished_at", "TEXT");
}

function migrationErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function recordMigrationStatus(
  db: DatabaseLike,
  migration: SchemaMigration,
  status: "running" | "applied" | "failed",
  errorMessage: string | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  await db.execute(
    `
      INSERT INTO schema_migrations (
        version,
        description,
        applied_at,
        status,
        error_message,
        started_at,
        finished_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(version) DO UPDATE SET
        description=excluded.description,
        applied_at=excluded.applied_at,
        status=excluded.status,
        error_message=excluded.error_message,
        started_at=COALESCE(schema_migrations.started_at, excluded.started_at),
        finished_at=excluded.finished_at
    `,
    [
      migration.version,
      migration.description,
      now,
      status,
      errorMessage,
      now,
      status === "running" ? null : now,
    ],
  );
}

export async function runMigrations(db: DatabaseLike, migrations: SchemaMigration[]): Promise<void> {
  await ensureMigrationTable(db);
  const appliedRows = await db.select<Array<{ version: string }>>(
    "SELECT version FROM schema_migrations WHERE status = 'applied'",
  );
  const applied = new Set(appliedRows.map((row) => row.version));

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    await recordMigrationStatus(db, migration, "running");
    try {
      await migration.up(db);
      await recordMigrationStatus(db, migration, "applied");
    } catch (err) {
      await recordMigrationStatus(db, migration, "failed", migrationErrorMessage(err));
      throw err;
    }
  }
}
