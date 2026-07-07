import Database from "@tauri-apps/plugin-sql";

/** 全项目只用得到这两个方法——见 getDb() 里为什么不直接返回原始 Database 实例。 */
export interface DbHandle {
  execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
}

let _dbPromise: Promise<DbHandle> | null = null;

const BUSY_ERROR_RE = /database is locked|database table is locked|SQLITE_BUSY/i;

/** "database is locked"这类瞬时锁冲突才重试；别的错误（语法错、约束冲突等）原样抛出。 */
export function isBusyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return BUSY_ERROR_RE.test(message);
}

/**
 * 遇到 busy 错误按退避延迟重试，其余错误/重试次数用尽后原样抛出。
 * 抽成独立函数，不依赖真实 Database，方便用假的失败/成功 fn 直接单测退避逻辑。
 *
 * 2026-07-07 加固（真实事故复现：app 刚启动那一刻并发查询最密集——对话列表/消息历史/
 * 模型列表/供应商配置/工作文件夹/价格同步/工具执行记录/编排状态等十几个 useEffect 几乎
 * 同时发起查询，sqlx 连接池在这个瞬间扩容出的新连接又没有 busy_timeout，原来
 * [100,300,800] 总共只留 1.2 秒退避——启动瞬间的并发爆发很容易把这点预算耗尽，导致一个
 * "刚打开 app 发的第一条消息"就写库失败且被上层静默吞掉）。加到 6 次、总计约 6.3 秒，
 * 覆盖启动突发窗口；真正的持续性锁冲突（如 app 被重复打开）该失败还是会失败，不会被
 * 这个无限掩盖。
 */
export async function withBusyRetry<T>(
  fn: () => Promise<T>,
  delaysMs: number[] = [100, 200, 400, 800, 1600, 3200],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delaysMs.length || !isBusyError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}

export async function getDb(): Promise<DbHandle> {
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

      // 修复（2026-07-05，用户实测"归档对话失败：数据库暂时被占用"仍会发生）：上面两条
      // PRAGMA 治标不彻底——tauri-plugin-sql 底层是 sqlx::Pool<Sqlite>（见其 close() 文档
      // 原话"Closes the database connection pool"），默认多连接池，不是单连接。journal_mode
      // 会写进数据库文件头、后续连接自动继承，但 busy_timeout 是连接级设置、不落盘：池子并发
      // 扩容时新开的连接默认 busy_timeout=0，一遇锁冲突立刻报错而不等待。插件目前的 Builder
      // 没有暴露 after_connect/pool 配置钩子，没法在 Rust 侧给每个新连接都设置。
      // 只能在这一层兜底：包一层"遇到 busy 就退避重试"，效果上补齐所有连接本该有的
      // busy_timeout 行为，全项目所有调用点自动生效，不用一个个改调用处。
      //
      // 注意：这里返回**新对象**、不直接改 db.execute/db.select——单测里 mock 的
      // Database.load 会返回同一个 vi.fn() 对象，原地重写会顶掉测试自己配置的 mock 函数。
      return {
        execute: (query: string, bindValues?: unknown[]) => withBusyRetry(() => db.execute(query, bindValues)),
        select: <T,>(query: string, bindValues?: unknown[]) => withBusyRetry(() => db.select<T>(query, bindValues)),
      };
    })();
  }
  return _dbPromise;
}
