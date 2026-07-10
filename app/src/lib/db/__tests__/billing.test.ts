import { describe, expect, it, vi, beforeEach } from "vitest";

// billing.ts 内部 `import { getDb } from "./connection"`；相对测试文件位置是 "../connection"。
// 用 vi.fn 把它替换成能注入自定义 fakeDb 的可控桩，于是 SELECT/EXECUTE 走我们的假实现，
// 不去碰真实 SQLite，也不依赖 tauri-plugin-sql。
vi.mock("../connection", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../connection";
import {
  modelPriceCatalog,
  priceSyncStatus,
  savingsEvents,
  cliSessions,
} from "../billing";

type FakeSelect = ReturnType<typeof vi.fn>;
type FakeExecute = ReturnType<typeof vi.fn>;

function makeDb() {
  const select: FakeSelect = vi.fn();
  const execute: FakeExecute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
  const db = { select, execute };
  vi.mocked(getDb).mockReset();
  vi.mocked(getDb).mockResolvedValue(db as never);
  return { db, select, execute };
}

// 各 DAO 对应的原始 db 行（snake_case 列名），便于测试 row 映射函数。
// 一些 null/undefined 分支我们就让列直接为 null/undefined，用来验 ?? null 兜底。

function rawPriceCatalogRow(
  over: Partial<{
    id: string;
    model_name: string;
    provider_type: string | null;
    input_per_1m: number;
    output_per_1m: number;
    cache_read_per_1m: number | null;
    cache_write_per_1m: number | null;
    context_window: number | null;
    source: "builtin" | "remote" | "manual";
    source_url: string | null;
    version: string;
    enabled: number;
    updated_at: string;
  }> = {},
) {
  return {
    id: "p-default",
    model_name: "gpt-5",
    provider_type: "openai",
    input_per_1m: 1.5,
    output_per_1m: 6.0,
    cache_read_per_1m: null,
    cache_write_per_1m: null,
    context_window: null,
    source: "builtin" as const,
    source_url: null,
    version: "v1",
    enabled: 1,
    updated_at: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

function rawPriceSyncRow(
  over: Partial<{
    id: string;
    source: string;
    source_url: string | null;
    last_attempt_at: string | null;
    last_success_at: string | null;
    last_error: string | null;
    catalog_version: string | null;
  }> = {},
) {
  return {
    id: "global",
    source: "openai",
    source_url: null,
    last_attempt_at: null,
    last_success_at: null,
    last_error: null,
    catalog_version: null,
    ...over,
  };
}

function rawSavingsRow(
  over: Partial<{
    id: string;
    usage_event_id: string | null;
    conversation_id: string | null;
    project_id: string | null;
    kind: "cache" | "routing" | "compression";
    baseline_model_id: string | null;
    actual_model_id: string | null;
    baseline_cost: number;
    actual_cost: number;
    saved_cost: number;
    currency: string;
    formula_version: string;
    explain_json: string;
    actual_price_catalog_id: string | null;
    baseline_price_catalog_id: string | null;
    created_at: string;
  }> = {},
) {
  return {
    id: "ev-default",
    usage_event_id: null,
    conversation_id: null,
    project_id: null,
    kind: "routing" as const,
    baseline_model_id: null,
    actual_model_id: null,
    baseline_cost: 0,
    actual_cost: 0,
    saved_cost: 0,
    currency: "USD",
    formula_version: "v1",
    explain_json: "{}",
    actual_price_catalog_id: null,
    baseline_price_catalog_id: null,
    created_at: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

function rawCliSessionRow(
  over: Partial<{
    id: string;
    provider_type: string;
    conversation_id: string | null;
    project_id: string | null;
    official_session_id: string;
    model_name: string | null;
    program: string | null;
    status: "active" | "completed" | "failed" | "unknown";
    last_event_at: string;
    created_at: string;
  }> = {},
) {
  return {
    id: "cli-default",
    provider_type: "claude-cli",
    conversation_id: null,
    project_id: null,
    official_session_id: "session-1",
    model_name: null,
    program: null,
    status: "active" as const,
    last_event_at: "2026-07-01T00:00:00.000Z",
    created_at: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// rowToModelPriceCatalogEntry 边界——通过 list/getById/create 间接走
// enabled===1 → true，其它 → false；snake_case → camelCase
// =============================================================================
describe("modelPriceCatalog — row mapping (enabled)", () => {
  it("enabled=1 → true", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([rawPriceCatalogRow({ enabled: 1, id: "p1" })]);
    const row = await modelPriceCatalog.getById("p1");
    expect(row!.enabled).toBe(true);
  });

  it("enabled=0 → false", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([rawPriceCatalogRow({ enabled: 0, id: "p1" })]);
    const row = await modelPriceCatalog.getById("p1");
    expect(row!.enabled).toBe(false);
  });

  it("所有 null 字段（provider/cache/context/sourceUrl）保留为 null", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([
      rawPriceCatalogRow({
        id: "p-null",
        provider_type: null,
        cache_read_per_1m: null,
        cache_write_per_1m: null,
        context_window: null,
        source_url: null,
      }),
    ]);
    const row = (await modelPriceCatalog.getById("p-null"))!;
    expect(row.providerType).toBeNull();
    expect(row.cacheReadPer1m).toBeNull();
    expect(row.cacheWritePer1m).toBeNull();
    expect(row.contextWindow).toBeNull();
    expect(row.sourceUrl).toBeNull();
  });

  it("snake_case 字段正确映射到 camelCase（input_per_1m → inputPer1m 等）", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([
      rawPriceCatalogRow({
        id: "p-camel",
        model_name: "claude-sonnet-5",
        input_per_1m: 3.0,
        output_per_1m: 15.0,
        updated_at: "2026-07-08T10:00:00.000Z",
      }),
    ]);
    const row = (await modelPriceCatalog.getById("p-camel"))!;
    expect(row.modelName).toBe("claude-sonnet-5");
    expect(row.inputPer1m).toBe(3.0);
    expect(row.outputPer1m).toBe(15.0);
    expect(row.updatedAt).toBe("2026-07-08T10:00:00.000Z");
  });
});

// =============================================================================
// modelPriceCatalog — list / listActive / countBySource / listVersions / lookupActive
// =============================================================================
describe("modelPriceCatalog — 只读路径", () => {
  it("list 走 SELECT 全表并按顺序返回映射后的行", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([
      rawPriceCatalogRow({ id: "p1" }),
      rawPriceCatalogRow({ id: "p2", model_name: "sonnet" }),
    ]);
    const rows = await modelPriceCatalog.list();
    expect(rows.map((r) => r.id)).toEqual(["p1", "p2"]);
    expect(select.mock.calls[0][0]).toMatch(/FROM model_price_catalog/);
    expect(select.mock.calls[0][0]).toMatch(/ORDER BY updated_at DESC, model_name ASC/);
  });

  it("list 返回空数组", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([]);
    await expect(modelPriceCatalog.list()).resolves.toEqual([]);
  });

  it("listActive 多带一个 WHERE enabled = 1", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([]);
    await expect(modelPriceCatalog.listActive()).resolves.toEqual([]);
    expect(select.mock.calls[0][0]).toMatch(/WHERE enabled = 1/);
  });

  it("countBySource 命中 → 返回 n；未命中 → 返回 0", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([{ n: 42 }]);
    await expect(modelPriceCatalog.countBySource("remote")).resolves.toBe(42);
    expect(select.mock.calls[0][1]).toEqual(["remote"]);

    select.mockResolvedValueOnce([]);
    await expect(modelPriceCatalog.countBySource("builtin")).resolves.toBe(0);
  });

  it("countBySource rows[0] 有但 n 字段缺失 → 返回 0（?? 0 兜底）", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([{}]); // 没有 n 字段
    await expect(modelPriceCatalog.countBySource("manual")).resolves.toBe(0);
  });

  it("listVersions 把数据库版本行映射成 ModelPriceCatalogVersion", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([
      {
        source: "remote" as const,
        version: "2026-07-01",
        entry_count: 10,
        enabled_count: 8,
        first_updated_at: "2026-07-01T00:00:00.000Z",
        last_updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]);
    const vs = await modelPriceCatalog.listVersions();
    expect(vs).toEqual([
      {
        source: "remote",
        version: "2026-07-01",
        entryCount: 10,
        enabledCount: 8,
        firstUpdatedAt: "2026-07-01T00:00:00.000Z",
        lastUpdatedAt: "2026-07-08T00:00:00.000Z",
      },
    ]);
    expect(select.mock.calls[0][0]).toMatch(/GROUP BY source, version/);
  });

  it("lookupActive 命中 → 返回映射后的行", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([rawPriceCatalogRow({ id: "p-lookup", enabled: 1 })]);
    const row = await modelPriceCatalog.lookupActive("gpt-5", "openai");
    expect(row!.id).toBe("p-lookup");
    expect(select.mock.calls[0][1]).toEqual(["gpt-5", "openai"]);
    // SQL 含 OR provider_type IS NULL 兜底 + lower() 比对 + LIMIT 1
    expect(select.mock.calls[0][0]).toMatch(/lower\(model_name\)/);
    expect(select.mock.calls[0][0]).toMatch(/LIMIT 1/);
  });

  it("lookupActive 未命中 → null（rows[0] 兜底）", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([]);
    await expect(modelPriceCatalog.lookupActive("nope", null)).resolves.toBeNull();
  });

  it("getById 未命中 → null", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([]);
    await expect(modelPriceCatalog.getById("missing")).resolves.toBeNull();
  });
});

// =============================================================================
// modelPriceCatalog — create / disable* / replaceSourceEntries
// =============================================================================
describe("modelPriceCatalog — 写入路径", () => {
  it("create：INSERT 走通，参数按列序写入，enabled 默认 true (boolToInt=1)；create 后再 getById", async () => {
    const { execute, select } = makeDb();
    // 第二次 select 由 create 内部 getById(newId) 触发，返回新插入的行
    select.mockResolvedValueOnce([rawPriceCatalogRow({ id: "newrow", enabled: 1 })]);

    const row = await modelPriceCatalog.create({
      modelName: "  gpt-5  ", // 源不 trim；modelName 原样进库
      providerType: "openai",
      inputPer1m: 1.0,
      outputPer1m: 5.0,
      source: "manual",
      version: "v1",
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO model_price_catalog/);
    expect(typeof params[0]).toBe("string"); // id = newId() = UUID
    expect((params[0] as string).length).toBeGreaterThan(0);
    expect(params[1]).toBe("  gpt-5  ");
    expect(params[2]).toBe("openai");
    expect(params[3]).toBe(1.0);
    expect(params[4]).toBe(5.0);
    expect(params[5]).toBeNull(); // cacheReadPer1m ?? null
    expect(params[6]).toBeNull(); // cacheWritePer1m ?? null
    expect(params[7]).toBeNull(); // contextWindow ?? null
    expect(params[8]).toBe("manual");
    expect(params[9]).toBeNull(); // sourceUrl ?? null
    expect(params[10]).toBe("v1");
    expect(params[11]).toBe(1); // boolToInt(true ?? true) = 1
    expect(typeof params[12]).toBe("string"); // now() = ISO

    expect(row.id).toBe("newrow");
    expect(row.enabled).toBe(true);
  });

  it("create：enabled=false 时 INSERT 参数里写 0；所有可选字段传值时正常落库", async () => {
    const { execute, select } = makeDb();
    select.mockResolvedValueOnce([
      rawPriceCatalogRow({
        id: "row-off",
        enabled: 0,
        cache_read_per_1m: 0.3,
        cache_write_per_1m: 3.0,
        context_window: 200000,
        source_url: "https://example.com/prices.json",
      }),
    ]);

    await modelPriceCatalog.create({
      modelName: "haiku",
      inputPer1m: 0.8,
      outputPer1m: 4.0,
      cacheReadPer1m: 0.3,
      cacheWritePer1m: 3.0,
      contextWindow: 200000,
      source: "remote",
      sourceUrl: "https://example.com/prices.json",
      version: "v2",
      enabled: false,
    });

    const [, params] = execute.mock.calls[0];
    expect(params[5]).toBe(0.3);
    expect(params[6]).toBe(3.0);
    expect(params[7]).toBe(200000);
    expect(params[9]).toBe("https://example.com/prices.json");
    expect(params[11]).toBe(0); // boolToInt(false)
  });

  it("create：insert 之后 getById 拿不到行 → 抛 'not found after create'", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([]); // getById 返回空
    await expect(
      modelPriceCatalog.create({
        modelName: "x",
        inputPer1m: 1,
        outputPer1m: 1,
        source: "builtin",
        version: "v1",
      }),
    ).rejects.toThrow(/not found after create/);
  });

  it("disableSource：UPDATE 把 enabled 置 0，按 source 过滤", async () => {
    const { execute } = makeDb();
    await modelPriceCatalog.disableSource("remote");
    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toMatch(/UPDATE model_price_catalog SET enabled = 0/);
    expect(sql).toMatch(/WHERE source = \$1/);
    expect(params).toEqual(["remote"]);
  });

  it("disableManualForModel：UPDATE 限定 source='manual' 且 lower() 比对", async () => {
    const { execute } = makeDb();
    await modelPriceCatalog.disableManualForModel("GPT-5", "openai");
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toMatch(/SET enabled = 0/);
    expect(sql).toMatch(/source = 'manual'/);
    expect(sql).toMatch(/lower\(model_name\) = lower\(\$1\)/);
    expect(params).toEqual(["GPT-5", "openai"]);
  });

  it("disableManualForModel：providerType 传 null 走 `($2 IS NULL AND provider_type IS NULL)` 分支", async () => {
    const { execute } = makeDb();
    await modelPriceCatalog.disableManualForModel("bare-model", null);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toMatch(/\$2 IS NULL AND provider_type IS NULL/);
    expect(params).toEqual(["bare-model", null]);
  });

  // ---- replaceSourceEntries (lines ~218-291，未覆盖区域核心) ----
  // DELETE 先执行；entries.length === 0 时跳过 INSERT 循环（只 DELETE）
  // entries.length <= 100 时单批 INSERT；>100 时分多批

  it("replaceSourceEntries：空 entries 数组 → 只 DELETE，不 INSERT", async () => {
    const { execute } = makeDb();
    await modelPriceCatalog.replaceSourceEntries("remote", []);
    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM model_price_catalog WHERE source = \$1/);
    expect(params).toEqual(["remote"]);
  });

  it("replaceSourceEntries：单批（<100 条）→ DELETE + 1 个多值 INSERT，参数顺序正确", async () => {
    const { execute } = makeDb();
    const entries = [
      {
        modelName: "gpt-5",
        providerType: "openai" as const,
        inputPer1m: 1.0,
        outputPer1m: 5.0,
        cacheReadPer1m: 0.3,
        contextWindow: 128000,
        source: "remote" as const,
        sourceUrl: "https://x",
        version: "v1",
        enabled: true,
      },
      {
        modelName: "haiku",
        // providerType/cacheReadPer1m/cacheWritePer1m/contextWindow/sourceUrl 全部省略
        inputPer1m: 0.5,
        outputPer1m: 2.0,
        source: "remote" as const,
        version: "v1",
        // enabled 省略 → 默认 true
      },
    ];
    await modelPriceCatalog.replaceSourceEntries("remote", entries);

    // DELETE + 1 个 batch INSERT
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0]).toMatch(/DELETE FROM model_price_catalog/);
    expect(execute.mock.calls[1][0]).toMatch(/INSERT INTO model_price_catalog/);

    // 第二条：多值 INSERT，每行 13 个占位符
    const [, params] = execute.mock.calls[1];
    expect(params.length).toBe(13 * 2);
    // 第一条
    expect(params[1]).toBe("gpt-5");
    expect(params[2]).toBe("openai");
    expect(params[3]).toBe(1.0);
    expect(params[5]).toBe(0.3); // cacheReadPer1m
    expect(params[7]).toBe(128000); // contextWindow
    expect(params[9]).toBe("https://x"); // sourceUrl
    expect(params[11]).toBe(1); // boolToInt(true)
    // 第二条：各 ?? null 兜底（以第一条的 params[0..12] 为前 13 个，所以第二条从 13 开始）
    expect(typeof params[13]).toBe("string"); // 第二条 id = newId()
    expect(params[14]).toBe("haiku");
    expect(params[15]).toBeNull(); // providerType ?? null
    expect(params[16]).toBe(0.5); // inputPer1m
    expect(params[17]).toBe(2.0); // outputPer1m
    expect(params[18]).toBeNull(); // cacheReadPer1m ?? null
    expect(params[19]).toBeNull(); // cacheWritePer1m ?? null
    expect(params[20]).toBeNull(); // contextWindow ?? null
    expect(params[21]).toBe("remote"); // source
    expect(params[22]).toBeNull(); // sourceUrl ?? null
    expect(params[23]).toBe("v1"); // version
    expect(params[24]).toBe(1); // boolToInt(undefined ?? true) = 1
    // ts 是 ISO 字符串
    expect(typeof params[12]).toBe("string");
    expect(typeof params[25]).toBe("string");
  });

  it("replaceSourceEntries：>100 条 → 分多个批次（DELETE + ceil(N/100) 个 INSERT）", async () => {
    const { execute } = makeDb();
    const entries = Array.from({ length: 250 }, (_, i) => ({
      modelName: `model-${i}`,
      inputPer1m: i,
      outputPer1m: i + 1,
      source: "remote" as const,
      version: "v1",
    }));
    await modelPriceCatalog.replaceSourceEntries("remote", entries);

    // 250 / 100 = 3 批 → 1 DELETE + 3 INSERT
    expect(execute).toHaveBeenCalledTimes(4);
    // 每批 INSERT 的参数都是 100 / 100 / 50 条 × 13 列
    expect(execute.mock.calls[1][1].length).toBe(100 * 13);
    expect(execute.mock.calls[2][1].length).toBe(100 * 13);
    expect(execute.mock.calls[3][1].length).toBe(50 * 13);
  });
});

// =============================================================================
// priceSyncStatus — get / upsert
// =============================================================================
describe("priceSyncStatus", () => {
  it("get：默认 id='global'，命中 → 映射返回", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([
      rawPriceSyncRow({
        id: "global",
        source: "remote",
        source_url: "https://x",
        last_attempt_at: "2026-07-08T00:00:00.000Z",
        last_success_at: "2026-07-08T01:00:00.000Z",
        last_error: null,
        catalog_version: "v2026-07-08",
      }),
    ]);
    const row = await priceSyncStatus.get();
    expect(row).toEqual({
      id: "global",
      source: "remote",
      sourceUrl: "https://x",
      lastAttemptAt: "2026-07-08T00:00:00.000Z",
      lastSuccessAt: "2026-07-08T01:00:00.000Z",
      lastError: null,
      catalogVersion: "v2026-07-08",
    });
    expect(select.mock.calls[0][1]).toEqual(["global"]);
  });

  it("get：传自定义 id → 用该 id 查", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([rawPriceSyncRow({ id: "custom" })]);
    const row = await priceSyncStatus.get("custom");
    expect(row!.id).toBe("custom");
    expect(select.mock.calls[0][1]).toEqual(["custom"]);
  });

  it("get：未命中 → null（rows[0] 兜底）", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([]);
    await expect(priceSyncStatus.get()).resolves.toBeNull();
  });

  it("upsert：INSERT ... ON CONFLICT DO UPDATE 走通，所有可选字段 ?? null 兜底；upsert 内部再 get 取最新行", async () => {
    const { execute, select } = makeDb();
    // 第二次 select 由 upsert 内部 this.get(id) 触发
    select.mockResolvedValueOnce([
      rawPriceSyncRow({
        id: "global",
        source: "remote",
        source_url: "https://y",
        last_error: "boom",
      }),
    ]);

    const row = await priceSyncStatus.upsert({
      source: "remote",
      sourceUrl: "https://y",
      lastError: "boom",
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO price_sync_status/);
    expect(sql).toMatch(/ON CONFLICT\(id\) DO UPDATE SET/);
    expect(sql).toMatch(/last_error = excluded\.last_error/);
    // 参数：id, source, sourceUrl ?? null, lastAttemptAt ?? null, lastSuccessAt ?? null, lastError ?? null, catalogVersion ?? null
    expect(params[0]).toBe("global");
    expect(params[1]).toBe("remote");
    expect(params[2]).toBe("https://y");
    expect(params[3]).toBeNull(); // lastAttemptAt ?? null
    expect(params[4]).toBeNull(); // lastSuccessAt ?? null
    expect(params[5]).toBe("boom");
    expect(params[6]).toBeNull(); // catalogVersion ?? null

    expect(row.id).toBe("global");
    expect(row.lastError).toBe("boom");
  });

  it("upsert：传自定义 id 时用该 id 而不是默认 'global'", async () => {
    const { execute, select } = makeDb();
    select.mockResolvedValueOnce([rawPriceSyncRow({ id: "anthropic" })]);
    await priceSyncStatus.upsert({ id: "anthropic", source: "anthropic" });
    expect(execute.mock.calls[0][1][0]).toBe("anthropic");
  });
});

// =============================================================================
// savingsEvents — create / list / summary（lines 139-161/202+ 等未覆盖区域）
// =============================================================================
describe("savingsEvents.create", () => {
  it("create：基本 INSERT 走通，所有可选字段 ?? null 兜底，默认 currency='USD'", async () => {
    const { execute } = makeDb();
    const returned = await savingsEvents.create({
      kind: "routing",
      baselineCost: 0.1,
      actualCost: 0.02,
      savedCost: 0.08,
      formulaVersion: "v1",
      explainJson: '{"reason":"hit-cache"}',
    });

    expect(typeof returned).toBe("string"); // newId() = UUID
    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO savings_events/);
    // 16 个参数：id, usageEventId ?? null, conversationId ?? null, projectId ?? null,
    //            kind, baselineModelId ?? null, actualModelId ?? null,
    //            baselineCost, actualCost, savedCost,
    //            currency ?? "USD", formulaVersion, explainJson,
    //            actualPriceCatalogId ?? null, baselinePriceCatalogId ?? null,
    //            ts
    expect(params[0]).toBe(returned);
    expect(params[1]).toBeNull(); // usageEventId ?? null
    expect(params[2]).toBeNull(); // conversationId ?? null
    expect(params[3]).toBeNull(); // projectId ?? null
    expect(params[4]).toBe("routing");
    expect(params[5]).toBeNull(); // baselineModelId ?? null
    expect(params[6]).toBeNull(); // actualModelId ?? null
    expect(params[7]).toBe(0.1);
    expect(params[8]).toBe(0.02);
    expect(params[9]).toBe(0.08);
    expect(params[10]).toBe("USD"); // currency ?? "USD" 默认
    expect(params[11]).toBe("v1");
    expect(params[12]).toBe('{"reason":"hit-cache"}');
    expect(params[13]).toBeNull(); // actualPriceCatalogId ?? null
    expect(params[14]).toBeNull(); // baselinePriceCatalogId ?? null
    expect(typeof params[15]).toBe("string"); // ts
  });

  it("create：传 currency 时原样落库；可选字段传值时不走 ?? null 分支", async () => {
    const { execute } = makeDb();
    await savingsEvents.create({
      usageEventId: "u-1",
      conversationId: "c-1",
      projectId: "p-1",
      kind: "cache",
      baselineModelId: "baseline-1",
      actualModelId: "actual-1",
      baselineCost: 0.5,
      actualCost: 0.1,
      savedCost: 0.4,
      currency: "CNY",
      formulaVersion: "v2",
      explainJson: "{}",
      actualPriceCatalogId: "apc-1",
      baselinePriceCatalogId: "bpc-1",
    });
    const [, params] = execute.mock.calls[0];
    expect(params[1]).toBe("u-1");
    expect(params[2]).toBe("c-1");
    expect(params[3]).toBe("p-1");
    expect(params[5]).toBe("baseline-1");
    expect(params[6]).toBe("actual-1");
    expect(params[10]).toBe("CNY");
    expect(params[13]).toBe("apc-1");
    expect(params[14]).toBe("bpc-1");
  });
});

// =============================================================================
// rowToSavingsEvent 边界——通过 list 间接走各种 null 组合
// =============================================================================
describe("savingsEvents — row mapping (rowToSavingsEvent)", () => {
  it("list 命中 → 映射：null 字段保留为 null（actual_price_catalog_id ?? null 兜底）", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([
      rawSavingsRow({
        id: "ev-1",
        usage_event_id: null,
        conversation_id: null,
        project_id: null,
        baseline_model_id: null,
        actual_model_id: null,
        actual_price_catalog_id: null,
        baseline_price_catalog_id: null,
      }),
    ]);
    const rows = await savingsEvents.list();
    expect(rows[0]).toEqual({
      id: "ev-1",
      usageEventId: null,
      conversationId: null,
      projectId: null,
      kind: "routing",
      baselineModelId: null,
      actualModelId: null,
      baselineCost: 0,
      actualCost: 0,
      savedCost: 0,
      currency: "USD",
      formulaVersion: "v1",
      explainJson: "{}",
      actualPriceCatalogId: null,
      baselinePriceCatalogId: null,
      createdAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("list 命中：所有字段都有值时正常映射（snake_case → camelCase）", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([
      rawSavingsRow({
        id: "ev-full",
        usage_event_id: "u-x",
        conversation_id: "c-x",
        project_id: "p-x",
        kind: "compression",
        baseline_model_id: "bm",
        actual_model_id: "am",
        baseline_cost: 1.0,
        actual_cost: 0.2,
        saved_cost: 0.8,
        currency: "CNY",
        formula_version: "v3",
        explain_json: '{"x":1}',
        actual_price_catalog_id: "apc-x",
        baseline_price_catalog_id: "bpc-x",
        created_at: "2026-07-09T12:00:00.000Z",
      }),
    ]);
    const rows = await savingsEvents.list();
    expect(rows[0].kind).toBe("compression");
    expect(rows[0].baselineModelId).toBe("bm");
    expect(rows[0].actualModelId).toBe("am");
    expect(rows[0].savedCost).toBe(0.8);
    expect(rows[0].currency).toBe("CNY");
    expect(rows[0].actualPriceCatalogId).toBe("apc-x");
    expect(rows[0].baselinePriceCatalogId).toBe("bpc-x");
    expect(rows[0].createdAt).toBe("2026-07-09T12:00:00.000Z");
  });

  it("rowToSavingsEvent 中 actual_price_catalog_id ?? null 兜底：传入 undefined 时也变 null", async () => {
    // 直接喂一条 raw row，actual_price_catalog_id 字段真的是 undefined（不是 null）。
    // rowToSavingsEvent 里用 ?? null，所以 undefined → null，与 null → null 等价。
    const { select } = makeDb();
    select.mockResolvedValueOnce([
      rawSavingsRow({
        id: "ev-undef",
        // 故意把字段设成 undefined
        actual_price_catalog_id: undefined as unknown as null,
        baseline_price_catalog_id: undefined as unknown as null,
      }),
    ]);
    const rows = await savingsEvents.list();
    expect(rows[0].actualPriceCatalogId).toBeNull();
    expect(rows[0].baselinePriceCatalogId).toBeNull();
  });
});

// =============================================================================
// savingsEvents.list — sinceTs 分支
// =============================================================================
describe("savingsEvents.list — sinceTs 条件分支", () => {
  it("不传 sinceTs → 走无 WHERE 子句的全表 SELECT", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([]);
    await savingsEvents.list();
    const sql = select.mock.calls[0][0];
    expect(sql).toMatch(/FROM savings_events/);
    expect(sql).not.toMatch(/WHERE/);
    expect(sql).toMatch(/ORDER BY created_at DESC/);
  });

  it("传 sinceTs → 走带 WHERE created_at >= $1 的 SELECT，并把 ts 当参数绑定", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([]);
    await savingsEvents.list("2026-07-01T00:00:00.000Z");
    const [sql, params] = select.mock.calls[0];
    expect(sql).toMatch(/WHERE created_at >= \$1/);
    expect(params).toEqual(["2026-07-01T00:00:00.000Z"]);
  });
});

// =============================================================================
// savingsEvents.summary — 聚合、traceable/missing 计数、byKind 排序、四舍五入
// =============================================================================
describe("savingsEvents.summary", () => {
  it("空 rows → 全 0，byKind=[]；eventCount 等于 rows.length", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([]);
    const summary = await savingsEvents.summary();
    expect(summary).toEqual({
      eventCount: 0,
      totalSavedCost: 0,
      traceableEventCount: 0,
      missingPriceCatalogEventCount: 0,
      byKind: [],
    });
  });

  it("三条事件：两条 traceable、一条 missing；按 kind 分组并 sorted by totalSavedCost DESC + kind ASC", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([
      rawSavingsRow({
        id: "e1",
        kind: "cache",
        saved_cost: 0.1,
        actual_price_catalog_id: "a",
        baseline_price_catalog_id: "b",
      }),
      rawSavingsRow({
        id: "e2",
        kind: "routing",
        saved_cost: 0.5,
        actual_price_catalog_id: "a",
        baseline_price_catalog_id: "b",
      }),
      rawSavingsRow({
        id: "e3",
        kind: "compression",
        saved_cost: 0.05,
        // 两 ID 都缺 → missingPriceCatalogEventCount +1
      }),
    ]);
    const summary = await savingsEvents.summary();
    expect(summary.eventCount).toBe(3);
    expect(summary.totalSavedCost).toBeCloseTo(0.65, 5);
    expect(summary.traceableEventCount).toBe(2);
    expect(summary.missingPriceCatalogEventCount).toBe(1);
    // byKind: routing(0.5) > cache(0.1) > compression(0.05)
    expect(summary.byKind.map((k) => k.kind)).toEqual(["routing", "cache", "compression"]);
    expect(summary.byKind[0].eventCount).toBe(1);
    expect(summary.byKind[0].totalSavedCost).toBeCloseTo(0.5, 5);
  });

  it("同 totalSavedCost 时按 kind.localeCompare 排序兜底（A < C < R）", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([
      rawSavingsRow({ id: "r", kind: "routing", saved_cost: 1.0 }),
      rawSavingsRow({ id: "c", kind: "compression", saved_cost: 1.0 }),
      rawSavingsRow({ id: "a", kind: "cache", saved_cost: 1.0 }),
    ]);
    const summary = await savingsEvents.summary();
    expect(summary.byKind.map((k) => k.kind)).toEqual(["cache", "compression", "routing"]);
  });

  it("traceable/missing 计数：仅 actual 缺一 → missing；都缺 → missing", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([
      rawSavingsRow({ id: "1", kind: "routing", actual_price_catalog_id: "a", baseline_price_catalog_id: null }),
      rawSavingsRow({ id: "2", kind: "routing", actual_price_catalog_id: null, baseline_price_catalog_id: "b" }),
      rawSavingsRow({ id: "3", kind: "routing", actual_price_catalog_id: null, baseline_price_catalog_id: null }),
    ]);
    const summary = await savingsEvents.summary();
    expect(summary.traceableEventCount).toBe(0);
    expect(summary.missingPriceCatalogEventCount).toBe(3);
  });

  it("summary 也接受 sinceTs 参数，传给 list", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([]);
    await savingsEvents.summary("2026-07-01T00:00:00.000Z");
    const [sql, params] = select.mock.calls[0];
    expect(sql).toMatch(/WHERE created_at >= \$1/);
    expect(params).toEqual(["2026-07-01T00:00:00.000Z"]);
  });
});

// =============================================================================
// cliSessions.upsert — 完全未覆盖区域（含 rowToCliSession）
// =============================================================================
describe("cliSessions.upsert", () => {
  it("upsert 走 INSERT ... ON CONFLICT(provider_type, official_session_id) DO UPDATE；可选字段 ?? null 默认；status 默认 'active'", async () => {
    const { execute, select } = makeDb();
    select.mockResolvedValueOnce([
      rawCliSessionRow({
        id: "cli-1",
        provider_type: "claude-cli",
        official_session_id: "sess-x",
        status: "active",
      }),
    ]);

    const row = await cliSessions.upsert({
      providerType: "claude-cli",
      officialSessionId: "sess-x",
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO cli_sessions/);
    expect(sql).toMatch(/ON CONFLICT\(provider_type, official_session_id\) DO UPDATE/);
    expect(sql).toMatch(/last_event_at = excluded\.last_event_at/);
    // 参数：newId(), providerType, conversationId ?? null, projectId ?? null,
    //       officialSessionId, modelName ?? null, program ?? null, status ?? "active",
    //       ts(last_event_at), ts(created_at)
    expect(typeof params[0]).toBe("string"); // newId()
    expect(params[1]).toBe("claude-cli");
    expect(params[2]).toBeNull(); // conversationId ?? null
    expect(params[3]).toBeNull(); // projectId ?? null
    expect(params[4]).toBe("sess-x");
    expect(params[5]).toBeNull(); // modelName ?? null
    expect(params[6]).toBeNull(); // program ?? null
    expect(params[7]).toBe("active"); // status ?? "active"
    expect(typeof params[8]).toBe("string"); // ts( last_event_at)
    expect(typeof params[9]).toBe("string"); // ts(created_at)

    // 之后 select 出该行
    const [selSql, selParams] = select.mock.calls[0];
    expect(selSql).toMatch(/FROM cli_sessions/);
    expect(selSql).toMatch(/provider_type = \$1 AND official_session_id = \$2 LIMIT 1/);
    expect(selParams).toEqual(["claude-cli", "sess-x"]);

    expect(row.id).toBe("cli-1");
    expect(row.providerType).toBe("claude-cli");
    expect(row.officialSessionId).toBe("sess-x");
  });

  it("upsert：可选字段全部传值时正常落库；status 可覆盖默认 'active'", async () => {
    const { execute, select } = makeDb();
    select.mockResolvedValueOnce([
      rawCliSessionRow({
        id: "cli-2",
        status: "failed",
        model_name: "haiku",
        program: "node",
        conversation_id: "c-1",
        project_id: "p-1",
      }),
    ]);

    await cliSessions.upsert({
      providerType: "codex-cli",
      conversationId: "c-1",
      projectId: "p-1",
      officialSessionId: "sess-y",
      modelName: "haiku",
      program: "node",
      status: "failed",
    });

    const [, params] = execute.mock.calls[0];
    expect(params[1]).toBe("codex-cli");
    expect(params[2]).toBe("c-1");
    expect(params[3]).toBe("p-1");
    expect(params[5]).toBe("haiku");
    expect(params[6]).toBe("node");
    expect(params[7]).toBe("failed");
  });

  it("upsert：SELECT 拿不到行（rows[0] 为 undefined）→ 运行时抛错（非空断言）", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([]); // select 返回空
    await expect(
      cliSessions.upsert({
        providerType: "claude-cli",
        officialSessionId: "sess-z",
      }),
    ).rejects.toThrow();
  });
});

// =============================================================================
// cliSessions.list + rowToCliSession 边界
// =============================================================================
describe("cliSessions.list — row mapping", () => {
  it("list 走 SELECT 全表并按 last_event_at DESC 返回映射后的行", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([
      rawCliSessionRow({ id: "cli-1", last_event_at: "2026-07-08T10:00:00.000Z" }),
      rawCliSessionRow({ id: "cli-2", last_event_at: "2026-07-08T11:00:00.000Z" }),
    ]);
    const rows = await cliSessions.list();
    expect(rows.map((r) => r.id)).toEqual(["cli-1", "cli-2"]);
    expect(select.mock.calls[0][0]).toMatch(/ORDER BY last_event_at DESC/);

    // 行映射：snake_case → camelCase + null 字段保留
    expect(rows[0]).toMatchObject({
      id: "cli-1",
      providerType: "claude-cli",
      conversationId: null,
      projectId: null,
      officialSessionId: "session-1",
      modelName: null,
      program: null,
      status: "active",
      lastEventAt: "2026-07-08T10:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("list 返回空数组", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([]);
    await expect(cliSessions.list()).resolves.toEqual([]);
  });

  it("list：所有 null 字段保留为 null（conversationId/projectId/modelName/program）", async () => {
    const { select } = makeDb();
    select.mockResolvedValueOnce([
      rawCliSessionRow({
        id: "cli-null",
        conversation_id: null,
        project_id: null,
        model_name: null,
        program: null,
        status: "unknown",
      }),
    ]);
    const rows = await cliSessions.list();
    expect(rows[0].conversationId).toBeNull();
    expect(rows[0].projectId).toBeNull();
    expect(rows[0].modelName).toBeNull();
    expect(rows[0].program).toBeNull();
    expect(rows[0].status).toBe("unknown");
  });
});
