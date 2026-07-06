import { describe, expect, it, vi } from "vitest";
import { addColumnIfMissing, runMigrations, type DatabaseLike, type SchemaMigration } from "../db-migrations";

type MigrationRow = {
  version: string;
  description: string;
  status: string;
  errorMessage?: string | null;
};

function makeDb(applied: string[] = []): DatabaseLike & {
  executed: string[];
  columns: Set<string>;
  migrationRows: MigrationRow[];
} {
  const executed: string[] = [];
  const columns = new Set<string>();
  const migrationRows: MigrationRow[] = applied.map((version) => ({
    version,
    description: "already applied",
    status: "applied",
  }));
  return {
    executed,
    columns,
    migrationRows,
    execute: vi.fn(async (sql: string, params?: unknown[]) => {
      executed.push(sql);
      if (sql.includes("schema_migrations") && sql.includes("status")) {
        const version = String(params?.[0] ?? "");
        const existing = migrationRows.find((row) => row.version === version);
        const row: MigrationRow = {
          version,
          description: String(params?.[1] ?? ""),
          status: String(params?.[3] ?? ""),
          errorMessage: params?.[4] == null ? null : String(params[4]),
        };
        if (existing) Object.assign(existing, row);
        else migrationRows.push(row);
      }
      return { rowsAffected: 1, lastInsertId: 1 };
    }),
    select: async <T>(sql: string): Promise<T> => {
      if (sql.includes("FROM schema_migrations")) {
        return migrationRows
          .filter((row) => row.status === "applied")
          .map((row) => ({ version: row.version })) as T;
      }
      if (sql.includes("PRAGMA table_info")) {
        return [...columns].map((name) => ({ name })) as T;
      }
      return [] as T;
    },
  };
}

describe("runMigrations", () => {
  it("创建迁移日志表，执行未记录迁移并写入版本", async () => {
    const db = makeDb();
    const migration: SchemaMigration = {
      version: "202607010001-test",
      description: "test migration",
      up: async (conn) => {
        await conn.execute("ALTER TABLE demo ADD COLUMN name TEXT");
      },
    };

    await runMigrations(db, [migration]);

    expect(db.executed.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS schema_migrations"))).toBe(true);
    expect(db.executed).toContain("ALTER TABLE demo ADD COLUMN name TEXT");
    expect(db.executed.some((sql) => sql.includes("INSERT INTO schema_migrations"))).toBe(true);
  });

  it("已记录的迁移不会重复执行", async () => {
    const db = makeDb(["202607010001-test"]);
    const up = vi.fn(async () => {});

    await runMigrations(db, [{ version: "202607010001-test", description: "test migration", up }]);

    expect(up).not.toHaveBeenCalled();
  });

  it("按传入顺序执行未记录迁移", async () => {
    const db = makeDb();
    const order: string[] = [];

    await runMigrations(db, [
      { version: "001", description: "first", up: async () => { order.push("first"); } },
      { version: "002", description: "second", up: async () => { order.push("second"); } },
    ]);

    expect(order).toEqual(["first", "second"]);
  });

  it("迁移失败时记录 failed 状态和错误信息，但不当作已完成版本", async () => {
    const db = makeDb();

    await expect(runMigrations(db, [
      { version: "bad", description: "bad migration", up: async () => { throw new Error("boom"); } },
    ])).rejects.toThrow("boom");

    expect(db.migrationRows).toContainEqual(expect.objectContaining({
      version: "bad",
      description: "bad migration",
      status: "failed",
      errorMessage: "boom",
    }));
  });

  it("failed 迁移下次运行会重试，成功后更新为 applied", async () => {
    const db = makeDb();
    db.migrationRows.push({
      version: "retry-me",
      description: "retry migration",
      status: "failed",
      errorMessage: "previous failure",
    });
    const up = vi.fn(async () => {});

    await runMigrations(db, [{ version: "retry-me", description: "retry migration", up }]);

    expect(up).toHaveBeenCalledTimes(1);
    expect(db.migrationRows.find((row) => row.version === "retry-me")).toEqual(expect.objectContaining({
      status: "applied",
      errorMessage: null,
    }));
  });
});

describe("addColumnIfMissing", () => {
  it("列不存在时才补列", async () => {
    const db = makeDb();

    await addColumnIfMissing(db, "messages", "attachments", "TEXT");

    expect(db.executed).toContain("ALTER TABLE messages ADD COLUMN attachments TEXT");
  });

  it("列已存在时跳过", async () => {
    const db = makeDb();
    db.columns.add("attachments");

    await addColumnIfMissing(db, "messages", "attachments", "TEXT");

    expect(db.executed.some((sql) => sql.includes("ADD COLUMN attachments"))).toBe(false);
  });
});
