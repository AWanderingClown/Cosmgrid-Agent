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
}

export async function runMigrations(db: DatabaseLike, migrations: SchemaMigration[]): Promise<void> {
  await ensureMigrationTable(db);
  const appliedRows = await db.select<Array<{ version: string }>>(
    "SELECT version FROM schema_migrations",
  );
  const applied = new Set(appliedRows.map((row) => row.version));

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    await migration.up(db);
    await db.execute(
      "INSERT INTO schema_migrations (version, description, applied_at) VALUES ($1,$2,$3)",
      [migration.version, migration.description, new Date().toISOString()],
    );
  }
}
