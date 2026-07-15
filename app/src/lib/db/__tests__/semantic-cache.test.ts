// D9（2026-07-15）：semantic_cache.listValid 过滤/分页单测。
// 用 vi.mock 替换 connection.getDb，断言不同 opts 生成的 SQL + 参数，
// 以及"不传 opts 时等价于旧实现（只按 expires_at 过滤，无全表无脑扫）"。
import { describe, it, expect, beforeEach, vi } from "vitest";

const selectSpy = vi.fn();

vi.mock("../connection", () => ({
  getDb: vi.fn().mockResolvedValue({
    select: (sql: string, params: unknown[]) => selectSpy(sql, params),
    execute: vi.fn(),
  }),
}));

import { semanticCache } from "../semantic-cache";

function fakeRow(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    query_text: "q",
    query_embedding: "[0.1]",
    response_text: "r",
    model_id: "m1",
    task_type: "standard",
    provider_name: "keyword-hash-v2",
    hit_count: 0,
    last_hit_at: null,
    expires_at: new Date(Date.now() + 1000).toISOString(),
    created_at: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  selectSpy.mockReset();
  selectSpy.mockResolvedValue([fakeRow()]);
});

describe("listValid — 默认（无 opts）", () => {
  it("只按 expires_at 过滤，保持旧行为、不使用全表扫描", async () => {
    const rows = await semanticCache.listValid();
    expect(rows).toHaveLength(1);
    const [sql, params] = selectSpy.mock.calls[0]!;
    expect(sql).toContain("WHERE expires_at > $1");
    expect(sql).not.toContain("provider_name");
    expect(sql).not.toContain("LIMIT");
    expect(params).toHaveLength(1);
  });
});

describe("listValid — 过滤条件", () => {
  it("providerName → 生成 provider_name = $N", async () => {
    await semanticCache.listValid({ providerName: "keyword-hash-v2" });
    const [sql, params] = selectSpy.mock.calls[0]!;
    expect(sql).toContain("provider_name = $2");
    expect(params).toEqual([expect.any(String), "keyword-hash-v2"]);
  });

  it("providerName + taskType + modelId 都传 → 三段等值 + expires 复合索引可用", async () => {
    await semanticCache.listValid({
      providerName: "p",
      taskType: "standard",
      modelId: "m1",
    });
    const [sql, params] = selectSpy.mock.calls[0]!;
    expect(sql).toContain("provider_name = $2");
    expect(sql).toContain("task_type = $3");
    expect(sql).toContain("model_id = $4");
    expect(params).toEqual([expect.any(String), "p", "standard", "m1"]);
  });

  it("limit → 末尾追加 LIMIT", async () => {
    await semanticCache.listValid({ providerName: "p", limit: 10 });
    const [sql, params] = selectSpy.mock.calls[0]!;
    expect(sql.trim().endsWith("LIMIT $3")).toBe(true);
    expect(params).toEqual([expect.any(String), "p", 10]);
  });

  it("空字符串 modelId 不算有效过滤（避免 '' 误匹配）", async () => {
    await semanticCache.listValid({ modelId: "" });
    const [sql, params] = selectSpy.mock.calls[0]!;
    expect(sql).not.toContain("model_id");
    expect(params).toHaveLength(1);
  });

  it("不同 provider 的过滤条件互不相同（跨 provider 不串扫）", async () => {
    await semanticCache.listValid({ providerName: "prov-A" });
    const aSql = selectSpy.mock.calls[0]![0] as string;
    const aParams = selectSpy.mock.calls[0]![1] as unknown[];
    selectSpy.mockClear();
    await semanticCache.listValid({ providerName: "prov-B" });
    const bSql = selectSpy.mock.calls[0]![0] as string;
    const bParams = selectSpy.mock.calls[0]![1] as unknown[];
    expect(aSql).toBe(bSql);
    expect(aParams[1]).not.toBe(bParams[1]);
  });
});
