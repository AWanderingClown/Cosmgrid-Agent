import { describe, expect, it, vi } from "vitest";
import { addColumnIfMissing, runMigrations, type DatabaseLike, type SchemaMigration } from "../db-migrations";

function makeDb(applied: string[] = []): DatabaseLike & { executed: string[]; columns: Set<string> } {
  const executed: string[] = [];
  const columns = new Set<string>();
  return {
    executed,
    columns,
    execute: vi.fn(async (sql: string, params?: unknown[]) => {
      executed.push(sql);
      if (sql.startsWith("INSERT INTO schema_migrations")) {
        applied.push(String(params?.[0] ?? ""));
      }
      return { rowsAffected: 1, lastInsertId: 1 };
    }),
    select: async <T>(sql: string): Promise<T> => {
      if (sql.includes("FROM schema_migrations")) {
        return applied.map((version) => ({ version })) as T;
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
    expect(db.executed.some((sql) => sql.startsWith("INSERT INTO schema_migrations"))).toBe(true);
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

  it("迁移失败时不写入 schema_migrations", async () => {
    const db = makeDb();

    await expect(runMigrations(db, [
      { version: "bad", description: "bad migration", up: async () => { throw new Error("boom"); } },
    ])).rejects.toThrow("boom");

    expect(db.executed.some((sql) => sql.startsWith("INSERT INTO schema_migrations"))).toBe(false);
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
