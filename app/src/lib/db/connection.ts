import Database from "@tauri-apps/plugin-sql";

let _dbPromise: Promise<Database> | null = null;

export async function getDb(): Promise<Database> {
  if (!_dbPromise) {
    // 用 promise 而非 db 实例做守卫：原来 `if (!_db) { _db = await ... }` 在并发调用下
    // （如启动时多处同时 getDb()）会在 await 挂起期间被第二次调用重新触发 Database.load。
    _dbPromise = (async () => {
      const db = await Database.load("sqlite:cosmgrid.db");
      // 默认 rollback-journal 模式下写锁独占，稍有并发读写（含同进程内多个 async 调用排队）
      // 就会直接抛 "database is locked"——对应用户报的"新建对话失败...数据库被占用"、
      // 删除对话要点好几次才生效。WAL 允许读写并发；busy_timeout 让偶发锁冲突自动等待重试
      // 而不是立刻报错，两者是社区标准做法，而不是掩盖问题的临时补丁。
      await db.execute("PRAGMA journal_mode = WAL");
      await db.execute("PRAGMA busy_timeout = 5000");
      return db;
    })();
  }
  return _dbPromise;
}
