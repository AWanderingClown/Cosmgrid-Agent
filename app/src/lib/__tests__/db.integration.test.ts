// db.ts 集成测试：用 node:sqlite 真跑 SQL（不是浅 mock execute）
// 覆盖此前 0% 的表 + initSchema 全部 DDL。$N 占位符转 ? 按出现顺序绑定（支持重复 $1）。
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

type SqlVal = string | number | bigint | null | Uint8Array;

const sqlite = new DatabaseSync(":memory:");

function bind(sql: string, params: unknown[] = []): { sql: string; values: SqlVal[] } {
  const values: SqlVal[] = [];
  const converted = sql.replace(/\$(\d+)/g, (_m, n: string) => {
    values.push((params[Number(n) - 1] ?? null) as SqlVal);
    return "?";
  });
  return { sql: converted, values };
}

const adapter = {
  execute: async (sql: string, params?: unknown[]) => {
    const { sql: s, values } = bind(sql, params);
    const info = sqlite.prepare(s).run(...values);
    return { rowsAffected: Number(info.changes), lastInsertId: Number(info.lastInsertRowid) };
  },
  select: async <T>(sql: string, params?: unknown[]): Promise<T> => {
    const { sql: s, values } = bind(sql, params);
    return sqlite.prepare(s).all(...values) as T;
  },
};

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: vi.fn(async () => adapter) },
}));

const db = await import("../db");

beforeAll(async () => {
  await db.initSchema();
});

describe("initSchema", () => {
  it("建出全部核心表", async () => {
    const tables = (
      await adapter.select<Array<{ name: string }>>(
        "SELECT name FROM sqlite_master WHERE type='table'",
      )
    ).map((r) => r.name);
    for (const t of [
      "providers",
      "api_credentials",
      "models",
      "conversations",
      "messages",
      "usage_events",
      "model_performance_stats",
      "semantic_cache",
      "debate_sessions",
      "tool_executions",
      "workspace_configs",
      "project_memories",
    ]) {
      expect(tables).toContain(t);
    }
  });

  it("不再建已删的死表 conversation_model_snapshots", async () => {
    const tables = (
      await adapter.select<Array<{ name: string }>>(
        "SELECT name FROM sqlite_master WHERE type='table'",
      )
    ).map((r) => r.name);
    expect(tables).not.toContain("conversation_model_snapshots");
  });
});

describe("conversations + 主对话", () => {
  it("create / list", async () => {
    const c = await db.conversations.create({ title: "测试会话", projectId: null });
    expect(c.id).toBeTruthy();
    expect(c.title).toBe("测试会话");
    const all = await db.conversations.list();
    expect(all.some((x) => x.id === c.id)).toBe(true);
  });

  it("getOrCreateMainChat 幂等：第二次返回同一条", async () => {
    const a = await db.conversations.getOrCreateMainChat("m1");
    const b = await db.conversations.getOrCreateMainChat("m2");
    expect(a.id).toBe(b.id);
    expect(a.projectId).toBeNull();
  });

  it("listMainChats 只列无项目会话 + rename/touch 排到最前 + delete 级联删消息", async () => {
    const c1 = await db.conversations.create({ title: "会话1", projectId: null });
    const c2 = await db.conversations.create({ title: "会话2", projectId: null });
    // 带项目的会话不应出现在主对话列表
    const proj = await db.projects.create({ name: "x" });
    await db.conversations.create({ title: "项目会话", projectId: proj.id });

    const mains = await db.conversations.listMainChats();
    expect(mains.every((c) => c.projectId === null)).toBe(true);
    expect(mains.some((c) => c.id === c1.id)).toBe(true);
    expect(mains.some((c) => c.title === "项目会话")).toBe(false);

    // rename 改标题；touch 不报错
    await db.conversations.rename(c1.id, "会话1-改");
    await db.conversations.touch(c1.id);
    const afterRename = await db.conversations.listMainChats();
    expect(afterRename.find((c) => c.id === c1.id)!.title).toBe("会话1-改");

    // delete 级联：先放条消息，删会话后消息也没了
    await db.messages.create({ conversationId: c2.id, role: "user", content: "hi" });
    await db.conversations.delete(c2.id);
    expect((await db.conversations.listMainChats()).some((c) => c.id === c2.id)).toBe(false);
    expect(await db.messages.listByConversation(c2.id)).toHaveLength(0);
  });

  it("orchestration 列存在且读写 JSON 往返", async () => {
    const c = await db.conversations.create({ title: "c-orch", projectId: null });
    // 初始为空
    expect(await db.conversations.getOrchestration(c.id)).toBeNull();
    // 写入再读出
    const json = JSON.stringify({ version: 1, nodes: [{ id: "n1", kind: "planning" }], currentNodeId: "n1" });
    await db.conversations.saveOrchestration(c.id, json);
    expect(await db.conversations.getOrchestration(c.id)).toBe(json);
  });

  it("saveOrchestration 不 bump updated_at（后台编排不顶到侧栏最前）", async () => {
    const c = await db.conversations.create({ title: "orch-ts", projectId: null });
    const before = (await db.conversations.list()).find((x) => x.id === c.id)!.updatedAt;
    await db.conversations.saveOrchestration(c.id, JSON.stringify({ version: 1, nodes: [], currentNodeId: null }));
    const after = (await db.conversations.list()).find((x) => x.id === c.id)!.updatedAt;
    expect(after).toBe(before);
  });
});

describe("messages", () => {
  it("create + listByConversation 按时间升序", async () => {
    const conv = await db.conversations.create({ title: "c-msg" });
    await db.messages.create({ conversationId: conv.id, role: "user", content: "你好" });
    await db.messages.create({
      conversationId: conv.id,
      role: "assistant",
      content: "回答",
      modelId: "gpt",
      inputTokens: 10,
      outputTokens: 20,
    });
    const list = await db.messages.listByConversation(conv.id);
    expect(list).toHaveLength(2);
    expect(list[0]!.role).toBe("user");
    expect(list[1]!.content).toBe("回答");
    expect(list[1]!.outputTokens).toBe(20);
  });
});

describe("usageEvents", () => {
  it("create + list", async () => {
    await db.usageEvents.create({ modelId: "mA", role: "main_chat", inputTokens: 5, outputTokens: 7, cost: 0.01 });
    const list = await db.usageEvents.list();
    expect(list.some((e) => e.modelId === "mA")).toBe(true);
  });

  it("setOutcomeForLatest 给最近一条无 outcome 的事件打标，返回 taskType", async () => {
    await db.usageEvents.create({ modelId: "mB", role: "hard_task" });
    const res = await db.usageEvents.setOutcomeForLatest("mB", "switched_up");
    expect(res).not.toBeNull();
    expect(res!.taskType).toBe("hard_task");
    // 已打标后再调用应找不到（无 outcome IS NULL 的）
    const again = await db.usageEvents.setOutcomeForLatest("mB", "accepted");
    expect(again).toBeNull();
  });

  it("list(sinceTs) 过滤掉更早的事件", async () => {
    const since = new Date(Date.now() + 60_000).toISOString(); // 未来时间，应过滤掉所有现有
    const list = await db.usageEvents.list(since);
    expect(list).toHaveLength(0);
  });

  it("阶段 F1：role_kind 字段写入 → 读取保留", async () => {
    // 创建时带 roleKind
    const id = await db.usageEvents.create({
      modelId: "mC", role: "main_chat", roleKind: "leader",
      inputTokens: 100, outputTokens: 50, cost: 0.02,
    });
    const list = await db.usageEvents.list();
    const e = list.find((x) => x.id === id);
    expect(e?.roleKind).toBe("leader");
  });

  it("阶段 F1：role_kind 不传 → 落 NULL（旧数据兼容）", async () => {
    const id = await db.usageEvents.create({
      modelId: "mD", role: "main_chat",
      // 没传 roleKind
    });
    const list = await db.usageEvents.list();
    const e = list.find((x) => x.id === id);
    expect(e?.roleKind).toBeNull();
  });

  it("阶段 F1：role_kind='stage'（ProjectDetailPage 路径）能落库", async () => {
    const id = await db.usageEvents.create({
      modelId: "mE", role: "hard_task", roleKind: "stage",
    });
    const list = await db.usageEvents.list();
    expect(list.find((x) => x.id === id)?.roleKind).toBe("stage");
  });
});

describe("阶段 F1：aggregateUsageByActorRole（端到端集成）", () => {
  // beforeEach 清表：测试用同一个 sqlite in-memory，跨 it 累积会污染断言
  beforeEach(async () => {
    // 直接走 sqlite.prepare 清（adapter 不暴露通用 DELETE）
    sqlite.exec("DELETE FROM usage_events");
  });

  it("★ 必查：3 跳 chain + 1 nudge 重答 → DB role_kind 落对 → 聚合分对", async () => {
    // 模拟 E2a runChain 3 跳 chain：architect → frontend → backend
    // + 第 2 跳 nudge 重答（同一 frontend 角色再来一次）
    await db.usageEvents.create({ modelId: "mA", role: "planning", roleKind: "architect", cost: 0.10 });
    await db.usageEvents.create({ modelId: "mB", role: "frontend", roleKind: "frontend", cost: 0.20 });
    // nudge 重答同一 frontend
    await db.usageEvents.create({ modelId: "mB", role: "frontend", roleKind: "frontend", cost: 0.20 });
    await db.usageEvents.create({ modelId: "mC", role: "backend", roleKind: "backend", cost: 0.15 });

    // 聚合（动态 import 避免循环依赖——测试直接在 db 上下文里 import）
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});

    // 期望：3 个 roleKind（architect/frontend/backend），frontend totalCost=0.40 (nudge 累加)
    expect(result).toHaveLength(3);
    const architect = result.find((r) => r.roleKind === "architect");
    const frontend = result.find((r) => r.roleKind === "frontend");
    const backend = result.find((r) => r.roleKind === "backend");
    expect(architect?.totalCost).toBeCloseTo(0.10);
    expect(frontend?.totalCost).toBeCloseTo(0.40); // ★ nudge 重答累加
    expect(backend?.totalCost).toBeCloseTo(0.15);
    // 同 roleKind + 同 modelId 合并一行（nudge 累加）：rows[0].cost = 0.40 (0.20+0.20)
    expect(frontend?.rows[0]!.cost).toBeCloseTo(0.40);
    expect(frontend?.rows[0]!.calls).toBe(2);
  });

  it("★ 必查：ChatPage 主对话 leader actor_role='leader' 落库 + 聚合独立组", async () => {
    await db.usageEvents.create({ modelId: "mLeader", role: "main_chat", roleKind: "leader", cost: 0.05 });

    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    const leaderGroup = result.find((r) => r.roleKind === "leader");
    expect(leaderGroup).toBeDefined();
    expect(leaderGroup?.totalCost).toBeCloseTo(0.05);
  });

  it("★ 必查：ProjectDetailPage stage actor_role='stage' 落库 + 聚合独立组（跟 leader 可分）", async () => {
    await db.usageEvents.create({ modelId: "mLeader", role: "main_chat", roleKind: "leader", cost: 0.05 });
    await db.usageEvents.create({ modelId: "mStage", role: "hard_task", roleKind: "stage", cost: 0.10 });

    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    expect(result.find((r) => r.roleKind === "leader")?.totalCost).toBeCloseTo(0.05);
    expect(result.find((r) => r.roleKind === "stage")?.totalCost).toBeCloseTo(0.10);
  });

  it("★ 必查：NULL roleKind 当独立'未分类'组（不过滤），排最后", async () => {
    await db.usageEvents.create({ modelId: "mA", role: "main_chat", roleKind: "leader", cost: 0.05 });
    await db.usageEvents.create({ modelId: "mB", role: "main_chat", cost: 0.03 }); // roleKind=NULL（旧数据）

    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    // 2 个组：leader + NULL
    expect(result).toHaveLength(2);
    expect(result[0]!.roleKind).toBe("leader");
    expect(result[1]!.roleKind).toBeNull(); // NULL 排最后
    // modelId 实际是 "mB"（测试创建时设了 modelId）—— (unknown model) 占位只在 modelId 真为 NULL 时触发
    expect(result[1]!.rows[0]!.modelId).toBe("mB");
  });

  it("projectId 过滤聚合", async () => {
    await db.usageEvents.create({ modelId: "m1", projectId: "pA", roleKind: "leader", cost: 0.01 });
    await db.usageEvents.create({ modelId: "m2", projectId: "pB", roleKind: "leader", cost: 0.02 });
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({ projectId: "pA" });
    expect(result).toHaveLength(1);
    expect(result[0]!.totalCost).toBeCloseTo(0.01);
  });

  // ====== H4 阶段 F1：aggregateUsageByActorRole 边界（review F1-9）======

  it("★ modelId=NULL → rows[0].modelId='(unknown model)' 占位", async () => {
    await db.usageEvents.create({ roleKind: "leader", cost: 0.05 });
    // 不传 modelId
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    expect(result[0]!.rows[0]!.modelId).toBe("(unknown model)");
  });

  it("cost=0 + tokens=0 边界：能聚合不报错", async () => {
    await db.usageEvents.create({ modelId: "mFree", roleKind: "leader", cost: 0, inputTokens: 0, outputTokens: 0 });
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    expect(result[0]!.totalCost).toBe(0);
    expect(result[0]!.totalCalls).toBe(1);
  });

  it("★ 同 roleKind + 同 modelId 多行 → SUM 累加正确（5+5+5=15）", async () => {
    await db.usageEvents.create({ modelId: "mA", roleKind: "frontend", cost: 5 });
    await db.usageEvents.create({ modelId: "mA", roleKind: "frontend", cost: 5 });
    await db.usageEvents.create({ modelId: "mA", roleKind: "frontend", cost: 5 });
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    const frontend = result.find((r) => r.roleKind === "frontend");
    expect(frontend?.totalCost).toBeCloseTo(15);
    expect(frontend?.totalCalls).toBe(3);
    // 单 modelId 合并到一行
    expect(frontend?.rows).toHaveLength(1);
  });

  it("★ 3 个非 NULL roleKind → 字母序排列（architect < backend < frontend）", async () => {
    await db.usageEvents.create({ modelId: "m", roleKind: "frontend", cost: 0.10 });
    await db.usageEvents.create({ modelId: "m", roleKind: "architect", cost: 0.20 });
    await db.usageEvents.create({ modelId: "m", roleKind: "backend", cost: 0.30 });
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    // 字母序：architect < backend < frontend
    expect(result.map((r) => r.roleKind)).toEqual(["architect", "backend", "frontend"]);
  });

  it("★ 同 roleKind 3 个 model → 按 cost DESC 排序（mB>mA>mC）", async () => {
    await db.usageEvents.create({ modelId: "mA", roleKind: "frontend", cost: 0.10 });
    await db.usageEvents.create({ modelId: "mB", roleKind: "frontend", cost: 0.50 });
    await db.usageEvents.create({ modelId: "mC", roleKind: "frontend", cost: 0.01 });
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    const frontend = result.find((r) => r.roleKind === "frontend")!;
    expect(frontend.rows.map((r) => r.modelId)).toEqual(["mB", "mA", "mC"]);
  });

  it("★ NULL roleKind × 多 model → 独立'未分类'组 + 多 row 累加", async () => {
    await db.usageEvents.create({ modelId: "mA", cost: 0.05 }); // roleKind 旧数据 NULL
    await db.usageEvents.create({ modelId: "mB", cost: 0.10 }); // roleKind 旧数据 NULL
    await db.usageEvents.create({ modelId: "mA", cost: 0.05 }); // 同 modelId 累加
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    const nullGroup = result.find((r) => r.roleKind === null)!;
    expect(nullGroup.totalCost).toBeCloseTo(0.20);
    expect(nullGroup.rows).toHaveLength(2); // mA 合并 + mB
  });

  it("★ stage vs RoleId 共存 → 按 actor_role 字符串精确分组（stage 不被当 RoleId 解析）", async () => {
    await db.usageEvents.create({ modelId: "m", roleKind: "frontend", cost: 0.10 });
    await db.usageEvents.create({ modelId: "m", roleKind: "stage", cost: 0.20 });
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    // 2 个独立组：frontend（RoleId）+ stage（命名空间外）
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.roleKind === "frontend")?.totalCost).toBeCloseTo(0.10);
    expect(result.find((r) => r.roleKind === "stage")?.totalCost).toBeCloseTo(0.20);
  });

  it("空表 → 返 []（不崩）", async () => {
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    expect(result).toEqual([]);
  });

  it("since 时间过滤：未来时间 → 返 []", async () => {
    await db.usageEvents.create({ modelId: "m", roleKind: "leader", cost: 0.05 });
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = await aggregateUsageByActorRole({ since: future });
    expect(result).toEqual([]);
  });

  it("projectId + since 同时过滤", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 60_000).toISOString();
    const future = new Date(now.getTime() + 60_000).toISOString();
    await db.usageEvents.create({ modelId: "m1", projectId: "pA", roleKind: "leader", cost: 0.01 });
    await db.usageEvents.create({ modelId: "m2", projectId: "pB", roleKind: "leader", cost: 0.02 });
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({ projectId: "pA", since: past });
    expect(result).toHaveLength(1);
    expect(result[0]!.totalCost).toBeCloseTo(0.01);
    // since=future → 0 条
    const result2 = await aggregateUsageByActorRole({ projectId: "pA", since: future });
    expect(result2).toEqual([]);
  });
});

describe("modelPerformanceStats", () => {
  it("upsert 插入后再 upsert 走 ON CONFLICT 更新", async () => {
    const base = {
      modelId: "mP",
      taskType: "main_chat",
      successRate: 0.9,
      avgInputTokens: 100,
      avgOutputTokens: 200,
      avgCost: 0.02,
      avgLatencyMs: 1200,
      sampleCount: 3,
      windowStart: new Date().toISOString(),
      windowEnd: new Date().toISOString(),
    };
    await db.modelPerformanceStats.upsert(base);
    await db.modelPerformanceStats.upsert({ ...base, successRate: 0.5, sampleCount: 9 });
    const got = await db.modelPerformanceStats.get("mP", "main_chat");
    expect(got).not.toBeNull();
    expect(got!.successRate).toBe(0.5);
    expect(got!.sampleCount).toBe(9);
    const all = await db.modelPerformanceStats.list();
    expect(all.filter((s) => s.modelId === "mP")).toHaveLength(1);
  });
});

describe("semanticCache", () => {
  it("create / listValid / recordHit / stats", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await db.semanticCache.create({
      queryText: "什么是闭包",
      queryEmbedding: [0.1, 0.2, 0.3],
      responseText: "闭包是...",
      modelId: "mC",
      taskType: "main_chat",
      expiresAt: future,
      providerName: "keyword-hash-v2",
    });
    const valid = await db.semanticCache.listValid();
    const row = valid.find((r) => r.queryText === "什么是闭包");
    expect(row).toBeTruthy();
    expect(row!.queryEmbedding).toEqual([0.1, 0.2, 0.3]);
    expect(row!.providerName).toBe("keyword-hash-v2");

    await db.semanticCache.recordHit(row!.id);
    const after = (await db.semanticCache.listValid()).find((r) => r.id === row!.id);
    expect(after!.hitCount).toBe(1);

    const stats = await db.semanticCache.stats();
    expect(stats.entries).toBeGreaterThanOrEqual(1);
    expect(stats.totalHits).toBeGreaterThanOrEqual(1);
  });

  it("deleteExpired 删掉过期条目，保留未过期", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    await db.semanticCache.create({
      queryText: "过期项",
      queryEmbedding: [0],
      responseText: "x",
      modelId: "mC",
      taskType: "main_chat",
      expiresAt: past,
    });
    await db.semanticCache.deleteExpired();
    const valid = await db.semanticCache.listValid();
    expect(valid.some((r) => r.queryText === "过期项")).toBe(false);
  });
});

describe("debateSessions", () => {
  it("create / getById / list / delete", async () => {
    const id = await db.debateSessions.create({
      topic: "选 React 还是 Vue",
      quickMode: true,
      rounds: [{ role: "solver", modelId: "mS", content: "React", inputTokens: 1, outputTokens: 2 }],
      finalSolution: "React",
    });
    const got = await db.debateSessions.getById(id);
    expect(got).not.toBeNull();
    expect(got!.quickMode).toBe(true);
    expect(got!.rounds).toHaveLength(1);
    expect(got!.rounds[0]!.role).toBe("solver");

    const list = await db.debateSessions.list();
    expect(list.some((d) => d.id === id)).toBe(true);

    await db.debateSessions.delete(id);
    expect(await db.debateSessions.getById(id)).toBeNull();
  });
});

describe("toolExecutions", () => {
  it("create / list / listByConversation", async () => {
    const conv = await db.conversations.create({ title: "c-tool" });
    await db.toolExecutions.create({
      conversationId: conv.id,
      toolName: "read",
      input: "{}",
      output: "file content",
      status: "success",
      userConfirmed: true,
      reversible: false,
      durationMs: 42,
    });
    const byConv = await db.toolExecutions.listByConversation(conv.id);
    expect(byConv).toHaveLength(1);
    expect(byConv[0]!.toolName).toBe("read");
    expect(byConv[0]!.userConfirmed).toBe(true);
    const recent = await db.toolExecutions.list();
    expect(recent.some((t) => t.conversationId === conv.id)).toBe(true);
  });
});

describe("workspaceConfigs", () => {
  it("set/getBlockedCommands + upsert 覆盖", async () => {
    const pid = "proj-ws";
    expect(await db.workspaceConfigs.getBlockedCommands(pid)).toEqual([]);
    await db.workspaceConfigs.setBlockedCommands(pid, ["rm", "curl"]);
    expect(await db.workspaceConfigs.getBlockedCommands(pid)).toEqual(["rm", "curl"]);
    await db.workspaceConfigs.setBlockedCommands(pid, ["wget"]);
    expect(await db.workspaceConfigs.getBlockedCommands(pid)).toEqual(["wget"]);
  });
});

describe("projectMemories", () => {
  it("create / listByProject 按 importance 降序 / getById / update / delete", async () => {
    const proj = await db.projects.create({ name: "mem-proj" });
    await db.projectMemories.create({ projectId: proj.id, kind: "lesson", title: "低", content: "c1", importance: 10 });
    const hi = await db.projectMemories.create({ projectId: proj.id, kind: "decision", title: "高", content: "c2", importance: 90 });
    const list = await db.projectMemories.listByProject(proj.id);
    expect(list).toHaveLength(2);
    expect(list[0]!.title).toBe("高"); // importance DESC

    const got = await db.projectMemories.getById(hi.id);
    expect(got!.kind).toBe("decision");

    const updated = await db.projectMemories.update(hi.id, { title: "高-改", importance: 95 });
    expect(updated.title).toBe("高-改");
    expect(updated.importance).toBe(95);

    await db.projectMemories.delete(hi.id);
    expect(await db.projectMemories.getById(hi.id)).toBeNull();
  });

  it("searchAcrossProjects 关键词命中 + excludeProjectId 排除", async () => {
    const projA = await db.projects.create({ name: "search-a" });
    const projB = await db.projects.create({ name: "search-b" });
    await db.projectMemories.create({ projectId: projA.id, kind: "context", title: "用 Tauri 打包", content: "桌面端", importance: 50 });
    await db.projectMemories.create({ projectId: projB.id, kind: "context", title: "另一个 Tauri 项目", content: "也用 Tauri", importance: 50 });

    const all = await db.projectMemories.searchAcrossProjects("Tauri");
    expect(all.length).toBeGreaterThanOrEqual(2);

    const excl = await db.projectMemories.searchAcrossProjects("Tauri", { excludeProjectId: projA.id });
    expect(excl.every((m) => m.projectId !== projA.id)).toBe(true);

    expect(await db.projectMemories.searchAcrossProjects("")).toEqual([]);
  });
});

describe("projectTemplateRoles", () => {
  it("create + listByTemplate 按 order 升序", async () => {
    const tpl = await db.projectTemplates.create({ name: "role-tpl" });
    await db.projectTemplateRoles.create({ templateId: tpl.id, workRole: "coder", modelId: "m1", order: 2 });
    await db.projectTemplateRoles.create({ templateId: tpl.id, workRole: "planner", modelId: "m2", order: 1 });
    const roles = await db.projectTemplateRoles.listByTemplate(tpl.id);
    expect(roles).toHaveLength(2);
    expect(roles[0]!.workRole).toBe("planner"); // order ASC
    expect(roles[1]!.workRole).toBe("coder");
  });
});

describe("CRUD update/delete 分支覆盖", () => {
  it("providers update 多字段 + delete", async () => {
    const p = await db.providers.create({ name: "P", type: "openai" });
    const u = await db.providers.update(p.id, { name: "P2", type: "anthropic", website: "http://x", notes: "n" });
    expect(u.name).toBe("P2");
    expect(u.website).toBe("http://x");
    await db.providers.delete(p.id);
    expect(await db.providers.getById(p.id)).toBeNull();
  });

  it("apiCredentials update + delete", async () => {
    const p = await db.providers.create({ name: "Pc", type: "openai" });
    const c = await db.apiCredentials.create({ providerId: p.id, name: "C", baseUrl: "http://b" });
    const u = await db.apiCredentials.update(c.id, {
      name: "C2",
      baseUrl: "http://b2",
      enabled: false,
      defaultModelId: "m",
      supportsStreaming: false,
      supportsFunctionCall: false,
      supportsVision: true,
    });
    expect(u.name).toBe("C2");
    expect(u.enabled).toBe(false);
    await db.apiCredentials.delete(c.id);
    expect(await db.apiCredentials.getById(c.id)).toBeNull();
  });

  it("models update + delete", async () => {
    const p = await db.providers.create({ name: "Pm", type: "openai" });
    const m = await db.models.create({ providerId: p.id, name: "gpt", workRoles: "main_chat" });
    const u = await db.models.update(m.id, {
      name: "gpt2",
      displayName: "GPT2",
      contextWindow: 8000,
      inputPrice: 1,
      outputPrice: 2,
      capabilityTags: "x",
      capabilityScore: "{}",
      workRoles: "hard_task",
      enabled: false,
    });
    expect(u.name).toBe("gpt2");
    expect(u.enabled).toBe(false);
    await db.models.delete(m.id);
    expect(await db.models.getById(m.id)).toBeNull();
  });

  it("tokenPlans update + delete", async () => {
    const p = await db.providers.create({ name: "Pt", type: "openai" });
    const tp = await db.tokenPlans.create({ providerId: p.id, name: "T", planType: "monthly", quotaUnit: "usd" });
    const u = await db.tokenPlans.update(tp.id, {
      name: "T2",
      totalQuota: 100,
      resetRule: "r",
      warningThresholds: "{}",
      autoTrackEnabled: false,
      manualUpdateRequired: true,
      usedQuota: 30,
      status: "active",
    });
    expect(u.name).toBe("T2");
    await db.tokenPlans.delete(tp.id);
    expect(await db.tokenPlans.getById(tp.id)).toBeNull();
  });

  it("projects update + projectStages update", async () => {
    const proj = await db.projects.create({ name: "PR" });
    const u = await db.projects.update(proj.id, {
      name: "PR2",
      description: "d",
      workspacePath: "/w",
      currentStage: "coder",
      status: "active",
    });
    expect(u.name).toBe("PR2");
    expect(u.status).toBe("active");
    const st = await db.projectStages.create({ projectId: proj.id, workRole: "coder", modelId: "m" });
    const su = await db.projectStages.update(st.id, { status: "completed", inputTokens: 10, outputTokens: 20 });
    expect(su.status).toBe("completed");
    expect(su.inputTokens).toBe(10);
    await db.projects.delete(proj.id);
    expect(await db.projects.getById(proj.id)).toBeNull();
  });

  it("projectTemplates update + delete", async () => {
    const tpl = await db.projectTemplates.create({ name: "TPL" });
    const u = await db.projectTemplates.update(tpl.id, { name: "TPL2", description: "d", icon: "i", isDefault: true });
    expect(u.name).toBe("TPL2");
    await db.projectTemplates.delete(tpl.id);
    expect(await db.projectTemplates.getById(tpl.id)).toBeNull();
  });
});

describe("seedBuiltInTemplates", () => {
  it("幂等播种：第二次不重复插入", async () => {
    await db.seedBuiltInTemplates();
    const after1 = (await db.projectTemplates.list()).length;
    expect(after1).toBeGreaterThan(0);
    await db.seedBuiltInTemplates();
    const after2 = (await db.projectTemplates.list()).length;
    expect(after2).toBe(after1);
  });
});

describe("getRoleBindingsForTemplate（阶段 D tidy：空字符串占位不进 Map）", () => {
  it("seed 完后默认 8 角色模板：modelId 都是空字符串占位 → Map 为空（编排走 fallback 自动选）", async () => {
    await db.seedBuiltInTemplates();
    // 找「默认 8 角色」内置模板
    const tpl = (await db.projectTemplates.list()).find((t) => t.name === "默认 8 角色");
    expect(tpl).toBeDefined();
    const bindings = await db.projectTemplateRoles.getRoleBindingsForTemplate(tpl!.id);
    expect(bindings.size).toBe(0); // 所有行的 modelId 是 '' → 全部跳过
  });

  it("用户给某角色配了真实 modelId → 该角色进 Map；其它空串占位仍跳过", async () => {
    await db.seedBuiltInTemplates();
    const tpl = (await db.projectTemplates.list()).find((t) => t.name === "默认 8 角色");
    expect(tpl).toBeDefined();

    // 给 frontend 角色绑一个真实 modelId（先用已存在的 models 表里的任意一个；这里用占位字符串测试——resolveOrchestration L2 会再校验 availableModels）
    const rows = await db.projectTemplateRoles.listByTemplate(tpl!.id);
    const frontendRow = rows.find((r) => r.workRole === "frontend");
    expect(frontendRow).toBeDefined();
    await db.projectTemplateRoles.update(frontendRow!.id, { modelId: "model-real-frontend" });

    const bindings = await db.projectTemplateRoles.getRoleBindingsForTemplate(tpl!.id);
    expect(bindings.size).toBe(1); // 只有 frontend 进 Map
    expect(bindings.get("frontend")).toBe("model-real-frontend");
  });
});
