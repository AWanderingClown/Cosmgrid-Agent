import { describe, expect, it, vi, beforeEach } from "vitest";
import { mcpServers, mcpServerApprovals } from "../mcp";

// mcp.ts 内部 `import { getDb } from "./connection"`；相对测试文件位置是 "../connection"。
// 用 vi.fn 把它替换成能注入自定义 fakeDb 的可控桩，于是 SELECT/EXECUTE 走我们的假实现，
// 不去碰真实 SQLite，也不依赖 tauri-plugin-sql。
vi.mock("../connection", () => ({
  getDb: vi.fn(),
}));

// getDb 的动态引用必须在 mock 设置完之后再 require 进来——vitest 的 vi.mock 是 hoist 的，
// 所以这里直接 import "../connection" 也能拿到 mocked 版本。但保险起见改走 dynamic re-import 模板。
import { getDb } from "../connection";

type FakeSelect = ReturnType<typeof vi.fn>;
type FakeExecute = ReturnType<typeof vi.fn>;

function makeDb() {
  const select: FakeSelect = vi.fn();
  const execute: FakeExecute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
  const db = { select, execute };
  // 每次 createDb 都准备好：getDb() → fakeDb
  vi.mocked(getDb).mockReset();
  vi.mocked(getDb).mockResolvedValue(db as never);
  return { db, select, execute };
}

// 构造一条数据库原始行的 helper：列名是 mcp.ts mapRow 里看到的下划线风格 (snake_case)，
// 这样可以让 mapRow 走真实的 parseStringArray / parseStringRecord 分支。
function rawRow(over: Partial<{
  id: string;
  name: string;
  transport: "remote_http" | "local_stdio";
  url: string | null;
  command: string | null;
  args_json: string | null;
  env_json: string | null;
  headers_json: string | null;
  secret_credential_id: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}> = {}) {
  return {
    id: "srv-default",
    name: "default",
    transport: "remote_http" as const,
    url: "https://example.com",
    command: null,
    args_json: "[]",
    env_json: "{}",
    headers_json: "{}",
    secret_credential_id: null,
    enabled: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// parseStringArray 边界——通过 mapRow 间接走：让 fakeDb.select 返回不同 args_json，
// 看 list()/getById() 解析出来是不是预期的 string[]
// =============================================================================
describe("parseStringArray (via mapRow)", () => {
  it("null → 空数组", async () => {
    const { db } = makeDb();
    vi.mocked(db.select).mockResolvedValue([rawRow({ args_json: null })]);
    const rows = await mcpServers.list();
    expect(rows[0].args).toEqual([]);
  });

  it("坏 JSON → 空数组（吞掉错误）", async () => {
    const { db } = makeDb();
    vi.mocked(db.select).mockResolvedValue([rawRow({ args_json: "{not-json" })]);
    const rows = await mcpServers.list();
    expect(rows[0].args).toEqual([]);
  });

  it("非数组（比如 object）→ 空数组", async () => {
    const { db } = makeDb();
    vi.mocked(db.select).mockResolvedValue([rawRow({ args_json: JSON.stringify({ a: 1 }) })]);
    const rows = await mcpServers.list();
    expect(rows[0].args).toEqual([]);
  });

  it("含非字符串项 → 只保留 string 项，其它过滤", async () => {
    const { db } = makeDb();
    vi.mocked(db.select).mockResolvedValue([
      rawRow({ args_json: JSON.stringify(["a", 1, null, "b", { x: 1 }, "c"]) }),
    ]);
    const rows = await mcpServers.list();
    expect(rows[0].args).toEqual(["a", "b", "c"]);
  });

  it("空数组 → []", async () => {
    const { db } = makeDb();
    vi.mocked(db.select).mockResolvedValue([rawRow({ args_json: "[]" })]);
    const rows = await mcpServers.list();
    expect(rows[0].args).toEqual([]);
  });

  it("合法 JSON 字符串数组 → 原样通过", async () => {
    const { db } = makeDb();
    vi.mocked(db.select).mockResolvedValue([rawRow({ args_json: '["--flag", "value"]' })]);
    const rows = await mcpServers.list();
    expect(rows[0].args).toEqual(["--flag", "value"]);
  });
});

// =============================================================================
// parseStringRecord 边界——同样经 mapRow 走 fakeDb.select 注入不同 env_json / headers_json
// =============================================================================
describe("parseStringRecord (via mapRow)", () => {
  it("null → 空对象", async () => {
    const { db } = makeDb();
    vi.mocked(db.select).mockResolvedValue([rawRow({ env_json: null, headers_json: null })]);
    const rows = await mcpServers.list();
    expect(rows[0].env).toEqual({});
    expect(rows[0].headers).toEqual({});
  });

  it("坏 JSON → 空对象", async () => {
    const { db } = makeDb();
    vi.mocked(db.select).mockResolvedValue([rawRow({ env_json: "{bad", headers_json: "{bad" })]);
    const rows = await mcpServers.list();
    expect(rows[0].env).toEqual({});
    expect(rows[0].headers).toEqual({});
  });

  it("JSON 是 null（parsed 是 falsy）→ 空对象", async () => {
    const { db } = makeDb();
    vi.mocked(db.select).mockResolvedValue([rawRow({ env_json: "null", headers_json: "null" })]);
    const rows = await mcpServers.list();
    expect(rows[0].env).toEqual({});
    expect(rows[0].headers).toEqual({});
  });

  it("JSON 是数组（object 判定失败）→ 空对象", async () => {
    const { db } = makeDb();
    vi.mocked(db.select).mockResolvedValue([rawRow({ env_json: "[1,2,3]", headers_json: "[]" })]);
    const rows = await mcpServers.list();
    expect(rows[0].env).toEqual({});
    expect(rows[0].headers).toEqual({});
  });

  it("含非字符串值 → 只保留 string->string 项", async () => {
    const { db } = makeDb();
    vi.mocked(db.select).mockResolvedValue([
      rawRow({
        env_json: JSON.stringify({ A: "yes", B: 1, C: null, D: { nested: true } }),
        headers_json: JSON.stringify({ X: "ok", Y: 42 }),
      }),
    ]);
    const rows = await mcpServers.list();
    expect(rows[0].env).toEqual({ A: "yes" });
    expect(rows[0].headers).toEqual({ X: "ok" });
  });

  it("空对象 '{}' → 空对象", async () => {
    const { db } = makeDb();
    vi.mocked(db.select).mockResolvedValue([rawRow({ env_json: "{}", headers_json: "{}" })]);
    const rows = await mcpServers.list();
    expect(rows[0].env).toEqual({});
    expect(rows[0].headers).toEqual({});
  });

  it("合法对象 → 原样通过", async () => {
    const { db } = makeDb();
    vi.mocked(db.select).mockResolvedValue([
      rawRow({
        env_json: JSON.stringify({ PATH: "/usr/bin", HOME: "/root" }),
        headers_json: JSON.stringify({ Authorization: "Bearer t" }),
      }),
    ]);
    const rows = await mcpServers.list();
    expect(rows[0].env).toEqual({ PATH: "/usr/bin", HOME: "/root" });
    expect(rows[0].headers).toEqual({ Authorization: "Bearer t" });
  });
});

// =============================================================================
// validateInput 边界——通过 mcpServers.create() 间接验证：
// 失败路径必须抛错，并且**不能**调用 db.execute / db.select
// =============================================================================
describe("validateInput (via mcpServers.create)", () => {
  it("name 为空 → 抛错", async () => {
    const { db } = makeDb();
    await expect(
      mcpServers.create({ name: "", transport: "remote_http", url: "https://x" } as never),
    ).rejects.toThrow(/between 1 and 100/);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("name 全是空格 → 抛错", async () => {
    const { db } = makeDb();
    await expect(
      mcpServers.create({ name: "   ", transport: "remote_http", url: "https://x" } as never),
    ).rejects.toThrow(/between 1 and 100/);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("name 超 100 字符 → 抛错", async () => {
    const { db } = makeDb();
    const longName = "a".repeat(101);
    await expect(
      mcpServers.create({ name: longName, transport: "remote_http", url: "https://x" } as never),
    ).rejects.toThrow(/between 1 and 100/);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("remote_http 但 url 为空 → 抛错", async () => {
    const { db } = makeDb();
    await expect(
      mcpServers.create({ name: "ok", transport: "remote_http", url: "" } as never),
    ).rejects.toThrow(/url is required/);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("remote_http 但 url 全是空格 → 抛错（trim 后视为空）", async () => {
    const { db } = makeDb();
    await expect(
      mcpServers.create({ name: "ok", transport: "remote_http", url: "   " } as never),
    ).rejects.toThrow(/url is required/);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("remote_http 但 url 不是合法 URL → 抛错", async () => {
    const { db } = makeDb();
    await expect(
      mcpServers.create({ name: "ok", transport: "remote_http", url: "not a url" } as never),
    ).rejects.toThrow(/url is invalid/);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("remote_http 但 url 协议不是 http/https（比如 javascript:）→ 抛错", async () => {
    const { db } = makeDb();
    await expect(
      mcpServers.create({ name: "ok", transport: "remote_http", url: "javascript:alert(1)" } as never),
    ).rejects.toThrow(/must use http or https/);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("remote_http 但 url 协议是 ftp → 抛错", async () => {
    const { db } = makeDb();
    await expect(
      mcpServers.create({ name: "ok", transport: "remote_http", url: "ftp://x.example/" } as never),
    ).rejects.toThrow(/must use http or https/);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("local_stdio 但 command 为空 → 抛错", async () => {
    const { db } = makeDb();
    await expect(
      mcpServers.create({ name: "ok", transport: "local_stdio", command: "" } as never),
    ).rejects.toThrow(/command is required/);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("command 超 1024 字符 → 抛错", async () => {
    const { db } = makeDb();
    const longCmd = "x".repeat(1025);
    await expect(
      mcpServers.create({ name: "ok", transport: "local_stdio", command: longCmd } as never),
    ).rejects.toThrow(/too long/);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("args 数量 > 128 → 抛错", async () => {
    const { db } = makeDb();
    const tooMany = Array.from({ length: 129 }, (_, i) => `--f${i}`);
    await expect(
      mcpServers.create({
        name: "ok",
        transport: "local_stdio",
        command: "echo",
        args: tooMany,
      } as never),
    ).rejects.toThrow(/exceed the supported limit/);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("单个 arg 超 4096 字符 → 抛错", async () => {
    const { db } = makeDb();
    await expect(
      mcpServers.create({
        name: "ok",
        transport: "local_stdio",
        command: "echo",
        args: ["--payload", "x".repeat(4097)],
      } as never),
    ).rejects.toThrow(/exceed the supported limit/);
    expect(db.execute).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 合法 create 路径——走 INSERT + getById
// =============================================================================
describe("mcpServers.create — happy path", () => {
  it("合法 remote_http：执行 INSERT，把所有参数序列化进去；getById 返回 mapRow 后的对象", async () => {
    const { execute, select } = makeDb();
    const createdRow = rawRow({
      id: "srv-1",
      name: "gh",
      transport: "remote_http",
      url: "https://api.example.com",
      args_json: JSON.stringify([]),
      env_json: "{}",
      headers_json: "{}",
      enabled: 1,
    });
    // 第一次 select 由 getById("srv-1") 返回刚插入的行
    select.mockResolvedValueOnce([createdRow]);

    const result = await mcpServers.create({
      name: "  gh  ", // 前后空格应被 trim
      transport: "remote_http",
      url: "  https://api.example.com  ",
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO mcp_servers/);
    // 参数顺序：id, name, transport, url, command, args_json, env_json, headers_json,
    //          secret_credential_id, enabled, created_at, updated_at
    expect(params[1]).toBe("gh"); // name trim
    expect(params[2]).toBe("remote_http");
    expect(params[3]).toBe("https://api.example.com"); // url trim
    expect(params[4]).toBeNull(); // command trim -> null

    // mapRow 后的最终对象
    expect(result.id).toBe("srv-1");
    expect(result.name).toBe("gh");
    expect(result.transport).toBe("remote_http");
    expect(result.url).toBe("https://api.example.com");
    expect(result.command).toBeNull();
    expect(result.args).toEqual([]);
    expect(result.env).toEqual({});
    expect(result.headers).toEqual({});
    expect(result.enabled).toBe(true);
  });

  it("合法 local_stdio：command 与 args 都进入 INSERT", async () => {
    const { execute, select } = makeDb();
    select.mockResolvedValueOnce([
      rawRow({
        id: "srv-2",
        name: "fs",
        transport: "local_stdio",
        url: null,
        command: "/bin/echo",
        args_json: JSON.stringify(["hi", "--flag"]),
        env_json: "{}",
        headers_json: "{}",
        enabled: 1,
      }),
    ]);

    const result = await mcpServers.create({
      name: "fs",
      transport: "local_stdio",
      command: "  /bin/echo  ",
      args: ["hi", "--flag"],
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const [, params] = execute.mock.calls[0];
    expect(params[1]).toBe("fs");
    expect(params[4]).toBe("/bin/echo"); // command trim
    expect(params[5]).toBe(JSON.stringify(["hi", "--flag"])); // args_json

    expect(result.command).toBe("/bin/echo");
    expect(result.args).toEqual(["hi", "--flag"]);
  });

  it("enabled=false 走 INSERT 参数里写 0", async () => {
    const { execute, select } = makeDb();
    select.mockResolvedValueOnce([
      rawRow({ id: "srv-3", name: "x", transport: "remote_http", enabled: 0 }),
    ]);
    await mcpServers.create({
      name: "x",
      transport: "remote_http",
      url: "https://x",
      enabled: false,
    } as never);
    const [, params] = execute.mock.calls[0];
    expect(params[9]).toBe(0);
  });
});

// =============================================================================
// mcpServers.update 路径
// =============================================================================
describe("mcpServers.update", () => {
  it("找不到现有记录（getById 返回空）→ 抛 'MCP server not found'，不发 SQL", async () => {
    const { select, execute } = makeDb();
    select.mockResolvedValueOnce([]); // getById(null-ish)
    await expect(
      mcpServers.update("missing", { name: "x" } as never),
    ).rejects.toThrow(/not found/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("合法更新：覆盖 name 后 UPDATE 走通，最终 mapRow 返回最新内容", async () => {
    const { select, execute } = makeDb();
    // 第一次 select：update 入口 getById('srv-1')
    select.mockResolvedValueOnce([
      rawRow({
        id: "srv-1",
        name: "old",
        transport: "remote_http",
        url: "https://old.example",
        enabled: 1,
      }),
    ]);
    // 第二次 select：UPDATE 之后再次 getById('srv-1')
    select.mockResolvedValueOnce([
      rawRow({
        id: "srv-1",
        name: "new",
        transport: "remote_http",
        url: "https://new.example",
        enabled: 1,
      }),
    ]);

    const updated = await mcpServers.update("srv-1", { name: "  new  ", url: "https://new.example" } as never);

    // execute 调用顺序：① DELETE FROM mcp_server_approvals  ② UPDATE mcp_servers
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0]).toMatch(/DELETE FROM mcp_server_approvals/);
    expect(execute.mock.calls[0][1]).toEqual(["srv-1"]);
    expect(execute.mock.calls[1][0]).toMatch(/UPDATE mcp_servers/);

    expect(updated.id).toBe("srv-1");
    expect(updated.name).toBe("new");
    expect(updated.url).toBe("https://new.example");
  });

  it("update 路径也会触发 validateInput：name 非法 → 抛错", async () => {
    const { select, execute } = makeDb();
    select.mockResolvedValueOnce([rawRow({ id: "srv-1", name: "ok", transport: "remote_http", url: "https://x" })]);
    await expect(
      mcpServers.update("srv-1", { name: "" } as never),
    ).rejects.toThrow(/between 1 and 100/);
    // 验证失败在 DELETE/UPDATE 之前发生——execute 不应被调用
    expect(execute).not.toHaveBeenCalled();
  });
});

// =============================================================================
// setEnabled(true) / setEnabled(false)
// =============================================================================
describe("mcpServers.setEnabled", () => {
  it("setEnabled(true) 不清 approvals，只 UPDATE", async () => {
    const { execute } = makeDb();
    await mcpServers.setEnabled("srv-x", true);
    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toMatch(/UPDATE mcp_servers SET enabled/);
    expect(sql).not.toMatch(/DELETE/);
    // 参数顺序：boolToInt(enabled), now(), id
    expect(params[0]).toBe(1);
    expect(params[2]).toBe("srv-x");
  });

  it("setEnabled(false) 先清 approvals 再 UPDATE", async () => {
    const { execute } = makeDb();
    await mcpServers.setEnabled("srv-x", false);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0]).toMatch(/DELETE FROM mcp_server_approvals/);
    expect(execute.mock.calls[0][1]).toEqual(["srv-x"]);
    expect(execute.mock.calls[1][0]).toMatch(/UPDATE mcp_servers SET enabled/);
    expect(execute.mock.calls[1][1][0]).toBe(0);
    expect(execute.mock.calls[1][1][2]).toBe("srv-x");
  });
});

// =============================================================================
// list / listEnabled / getById / setSecretCredential / delete
// =============================================================================
describe("mcpServers — 其它只读/写入路径", () => {
  it("list 走 SELECT * FROM mcp_servers ORDER BY updated_at DESC", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([
      rawRow({ id: "a", name: "A" }),
      rawRow({ id: "b", name: "B" }),
    ]);
    const rows = await mcpServers.list();
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(select.mock.calls[0][0]).toMatch(/FROM mcp_servers/);
    expect(select.mock.calls[0][0]).toMatch(/ORDER BY updated_at DESC/);
  });

  it("listEnabled 多带一个 WHERE enabled=1", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([]);
    await mcpServers.listEnabled();
    expect(select.mock.calls[0][0]).toMatch(/WHERE enabled = 1/);
  });

  it("getById 命中 → 返回 mapRow 的对象；未命中 → null", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([rawRow({ id: "hit" })]);
    expect((await mcpServers.getById("hit"))!.id).toBe("hit");

    select.mockResolvedValueOnce([]);
    expect(await mcpServers.getById("miss")).toBeNull();
  });

  it("setSecretCredential 走 UPDATE 把 env/headers 清空成 '{}'", async () => {
    const { execute } = makeDb();
    await mcpServers.setSecretCredential("srv-1", "cred-1");
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toMatch(/UPDATE mcp_servers/);
    expect(sql).toMatch(/env_json = '\{}'/);
    expect(sql).toMatch(/headers_json = '\{}'/);
    expect(params[0]).toBe("cred-1");
    expect(params[2]).toBe("srv-1");
  });

  it("setSecretCredential(null) 允许 null 凭证", async () => {
    const { execute } = makeDb();
    await mcpServers.setSecretCredential("srv-1", null);
    expect(execute.mock.calls[0][1][0]).toBeNull();
  });

  it("delete 走 DELETE approvals + DELETE row", async () => {
    const { execute } = makeDb();
    await mcpServers.delete("srv-1");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0]).toMatch(/DELETE FROM mcp_server_approvals/);
    expect(execute.mock.calls[0][1]).toEqual(["srv-1"]);
    expect(execute.mock.calls[1][0]).toMatch(/DELETE FROM mcp_servers/);
    expect(execute.mock.calls[1][1]).toEqual(["srv-1"]);
  });
});

// =============================================================================
// mcpServerApprovals: isApproved / approve / revokeForServer
// =============================================================================
describe("mcpServerApprovals", () => {
  const input = {
    serverId: "srv-1",
    workspacePath: "/repo",
    configFingerprint: "fp-abc",
  };

  it("isApproved：命中返回 true", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([{ approved: 1 }]);
    await expect(mcpServerApprovals.isApproved(input)).resolves.toBe(true);
    expect(select.mock.calls[0][0]).toMatch(/FROM mcp_server_approvals/);
    expect(select.mock.calls[0][1]).toEqual(["srv-1", "/repo", "fp-abc"]);
  });

  it("isApproved：未命中返回 false", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([]);
    await expect(mcpServerApprovals.isApproved(input)).resolves.toBe(false);
  });

  it("approve 走 INSERT OR REPLACE INTO mcp_server_approvals", async () => {
    const { execute } = makeDb();
    await mcpServerApprovals.approve(input);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toMatch(/INSERT OR REPLACE INTO mcp_server_approvals/);
    // 参数：server_id, workspace_path, config_fingerprint, now()
    expect(params[0]).toBe("srv-1");
    expect(params[1]).toBe("/repo");
    expect(params[2]).toBe("fp-abc");
    expect(typeof params[3]).toBe("string"); // ISO 时间戳
  });

  it("revokeForServer 走 DELETE approvals WHERE server_id", async () => {
    const { execute } = makeDb();
    await mcpServerApprovals.revokeForServer("srv-9");
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM mcp_server_approvals WHERE server_id/);
    expect(params[0]).toBe("srv-9");
  });
});
