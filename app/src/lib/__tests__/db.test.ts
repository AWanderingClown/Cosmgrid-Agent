// db.ts 单元测试（mock tauri-plugin-sql，不依赖真实 Tauri 运行时）
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @tauri-apps/plugin-sql
const rows: Record<string, unknown[]> = {};
const mockDb = {
  execute: vi.fn(async (sql: string) => {
    // 支持 INSERT 语句简单追踪（不实际执行）
    void sql;
    return { rowsAffected: 1, lastInsertId: 1 };
  }),
  select: vi.fn(async <T>(sql: string, params?: unknown[]) => {
    void params;
    // 根据 sql 关键词返回 mock 数据
    if (sql.includes("FROM providers")) {
      return rows["providers"] as T ?? ([] as unknown as T);
    }
    if (sql.includes("FROM api_credentials")) {
      return rows["api_credentials"] as T ?? ([] as unknown as T);
    }
    if (sql.includes("FROM models")) {
      return rows["models"] as T ?? ([] as unknown as T);
    }
    if (sql.includes("FROM projects")) {
      return rows["projects"] as T ?? ([] as unknown as T);
    }
    if (sql.includes("FROM project_stages")) {
      return rows["project_stages"] as T ?? ([] as unknown as T);
    }
    if (sql.includes("FROM checkpoints")) {
      return rows["checkpoints"] as T ?? ([] as unknown as T);
    }
    if (sql.includes("FROM handoff_packets")) {
      return rows["handoff_packets"] as T ?? ([] as unknown as T);
    }
    return [] as unknown as T;
  }),
};

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: vi.fn(async () => mockDb),
  },
}));

// 动态 import 确保 mock 先生效
const { providers, apiCredentials, models, projectTemplates, tokenPlans, projects, projectStages, checkpoints, handoffPackets, renderHandoffMarkdown } = await import("../db");

describe("providers", () => {
  beforeEach(() => {
    rows["providers"] = [];
    vi.clearAllMocks();
    mockDb.execute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 1 });
    mockDb.select.mockImplementation(async <T>(sql: string) => {
      if (sql.includes("FROM providers")) return rows["providers"] as T ?? ([] as unknown as T);
      return [] as unknown as T;
    });
  });

  it("list() 返回空数组（无数据时）", async () => {
    rows["providers"] = [];
    const result = await providers.list();
    expect(result).toEqual([]);
  });

  it("create() 调用 db.execute", async () => {
    rows["providers"] = [
      { id: "test-id", name: "Anthropic", type: "anthropic", website: null, notes: null, created_at: "2024-01-01T00:00:00.000Z", updated_at: "2024-01-01T00:00:00.000Z" },
    ];
    mockDb.select.mockImplementation(async <T>(sql: string) => {
      if (sql.includes("WHERE id = ")) return rows["providers"] as T;
      if (sql.includes("FROM providers")) return rows["providers"] as T;
      return [] as unknown as T;
    });

    const result = await providers.create({ name: "Anthropic", type: "anthropic" });
    expect(mockDb.execute).toHaveBeenCalled();
    expect(result.name).toBe("Anthropic");
    expect(result.type).toBe("anthropic");
  });
});

describe("models", () => {
  beforeEach(() => {
    rows["models"] = [];
    vi.clearAllMocks();
    mockDb.select.mockImplementation(async <T>(sql: string) => {
      if (sql.includes("FROM models")) return rows["models"] as T ?? ([] as unknown as T);
      return [] as unknown as T;
    });
  });

  it("listEnabled() 只查 enabled=1 的记录", async () => {
    rows["models"] = [
      {
        id: "m1", provider_id: "p1", name: "claude-sonnet-4-6",
        display_name: null, context_window: 200000, input_price: 3, output_price: 15,
        capability_tags: null, capability_score: null, work_roles: '["main_chat"]',
        enabled: 1, created_at: "2024-01-01T00:00:00.000Z", updated_at: "2024-01-01T00:00:00.000Z",
      },
    ];
    const result = await models.listEnabled();
    expect(result).toHaveLength(1);
    expect(result[0]!.enabled).toBe(true);
    expect(result[0]!.name).toBe("claude-sonnet-4-6");
  });
});

describe("projectTemplates", () => {
  beforeEach(() => {
    rows["project_templates"] = [];
    vi.clearAllMocks();
    mockDb.execute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 1 });
    mockDb.select.mockImplementation(async <T>(sql: string) => {
      if (sql.includes("FROM project_templates")) return rows["project_templates"] as T ?? ([] as unknown as T);
      return [] as unknown as T;
    });
  });

  it("list() 返回空数组（无数据时）", async () => {
    const result = await projectTemplates.list();
    expect(result).toEqual([]);
  });

  it("create() 调用 db.execute 并返回新建模板", async () => {
    rows["project_templates"] = [
      { id: "tpl-1", name: "全栈 Web 项目模板", description: null, icon: null, is_built_in: 0, is_default: 0, created_at: "2024-01-01T00:00:00.000Z", updated_at: "2024-01-01T00:00:00.000Z" },
    ];
    const result = await projectTemplates.create({ name: "全栈 Web 项目模板" });
    expect(mockDb.execute).toHaveBeenCalled();
    expect(result.name).toBe("全栈 Web 项目模板");
    expect(result.isBuiltIn).toBe(false);
  });
});

describe("tokenPlans", () => {
  beforeEach(() => {
    rows["token_plans"] = [];
    vi.clearAllMocks();
    mockDb.execute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 1 });
    mockDb.select.mockImplementation(async <T>(sql: string) => {
      if (sql.includes("FROM token_plans")) return rows["token_plans"] as T ?? ([] as unknown as T);
      return [] as unknown as T;
    });
  });

  it("list() 返回空数组（无数据时）", async () => {
    const result = await tokenPlans.list();
    expect(result).toEqual([]);
  });

  it("create() 默认 usedQuota 为 0、status 为 active", async () => {
    rows["token_plans"] = [
      {
        id: "tp-1", provider_id: "p1", linked_api_credential_id: null, name: "Claude Code Max",
        plan_type: "monthly", quota_unit: "usd", total_quota: 100, used_quota: 0,
        reset_rule: null, next_reset_at: null, warning_thresholds: null, status: "active",
        auto_track_enabled: 0, manual_update_required: 0, fallback_model_id: null,
        created_at: "2024-01-01T00:00:00.000Z", updated_at: "2024-01-01T00:00:00.000Z",
      },
    ];
    const result = await tokenPlans.create({ providerId: "p1", name: "Claude Code Max", planType: "monthly", quotaUnit: "usd", totalQuota: 100 });
    expect(result.usedQuota).toBe(0);
    expect(result.status).toBe("active");
  });
});

describe("projects", () => {
  beforeEach(() => {
    rows["projects"] = [];
    vi.clearAllMocks();
    mockDb.execute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 1 });
    mockDb.select.mockImplementation(async <T>(sql: string) => {
      if (sql.includes("FROM projects")) return rows["projects"] as T ?? ([] as unknown as T);
      return [] as unknown as T;
    });
  });

  it("list() 返回空数组（无数据时）", async () => {
    const result = await projects.list();
    expect(result).toEqual([]);
  });

  it("create() 默认 currentStage 为 main_chat、status 为 pending", async () => {
    rows["projects"] = [
      {
        id: "proj-1", name: "电商网站", description: null, template_id: null,
        current_stage: "main_chat", status: "pending", workspace_path: null,
        created_at: "2024-01-01T00:00:00.000Z", updated_at: "2024-01-01T00:00:00.000Z",
      },
    ];
    const result = await projects.create({ name: "电商网站" });
    expect(mockDb.execute).toHaveBeenCalled();
    expect(result.name).toBe("电商网站");
    expect(result.currentStage).toBe("main_chat");
    expect(result.status).toBe("pending");
  });

  it("update() 可以更新 status", async () => {
    rows["projects"] = [
      {
        id: "proj-1", name: "电商网站", description: null, template_id: null,
        current_stage: "main_chat", status: "active", workspace_path: null,
        created_at: "2024-01-01T00:00:00.000Z", updated_at: "2024-01-01T00:00:00.000Z",
      },
    ];
    const result = await projects.update("proj-1", { status: "active" });
    expect(mockDb.execute).toHaveBeenCalled();
    expect(result.status).toBe("active");
  });
});

describe("projectStages", () => {
  beforeEach(() => {
    rows["project_stages"] = [];
    vi.clearAllMocks();
    mockDb.execute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 1 });
    mockDb.select.mockImplementation(async <T>(sql: string) => {
      if (sql.includes("FROM project_stages")) return rows["project_stages"] as T ?? ([] as unknown as T);
      return [] as unknown as T;
    });
  });

  it("listByProject() 返回空数组（无数据时）", async () => {
    const result = await projectStages.listByProject("proj-1");
    expect(result).toEqual([]);
  });

  it("create() 默认 status 为 pending", async () => {
    rows["project_stages"] = [
      {
        id: "stage-1", project_id: "proj-1", work_role: "frontend", model_id: "m1",
        started_at: "2024-01-01T00:00:00.000Z", completed_at: null, status: "pending",
        input_tokens: 0, output_tokens: 0, cost: 0, output_summary: null, error_message: null,
      },
    ];
    const result = await projectStages.create({ projectId: "proj-1", workRole: "frontend", modelId: "m1" });
    expect(mockDb.execute).toHaveBeenCalled();
    expect(result.status).toBe("pending");
    expect(result.workRole).toBe("frontend");
  });
});

describe("apiCredentials", () => {
  beforeEach(() => {
    rows["api_credentials"] = [];
    vi.clearAllMocks();
    mockDb.select.mockImplementation(async <T>(sql: string) => {
      if (sql.includes("FROM api_credentials")) return rows["api_credentials"] as T ?? ([] as unknown as T);
      return [] as unknown as T;
    });
  });

  it("list() 返回空数组", async () => {
    const result = await apiCredentials.list();
    expect(result).toEqual([]);
  });
});

describe("checkpoints", () => {
  beforeEach(() => {
    rows["checkpoints"] = [];
    rows["handoff_packets"] = [];
    vi.clearAllMocks();
    mockDb.execute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 1 });
    mockDb.select.mockImplementation(async <T>(sql: string) => {
      if (sql.includes("FROM checkpoints")) return rows["checkpoints"] as T ?? ([] as unknown as T);
      if (sql.includes("FROM handoff_packets")) return rows["handoff_packets"] as T ?? ([] as unknown as T);
      return [] as unknown as T;
    });
  });

  it("listByProject() 返回空数组（无数据时）", async () => {
    const result = await checkpoints.listByProject("proj-1");
    expect(result).toEqual([]);
  });

  it("create() 存一条检查点 + camelCase 字段映射正确", async () => {
    const cpRow = {
      id: "cp-1", project_id: "proj-1", title: "前端完成",
      goal: "完成登录页", completed_summary: null, current_context: null,
      decisions: null, failed_attempts: null, blockers: null, next_steps: null,
      do_not_repeat: null, acceptance_criteria: null,
      created_by_model_id: null, created_at: "2024-01-01T00:00:00.000Z",
    };
    rows["checkpoints"] = [cpRow];
    const result = await checkpoints.create({
      projectId: "proj-1",
      title: "前端完成",
      goal: "完成登录页",
    });
    expect(mockDb.execute).toHaveBeenCalled();
    expect(result.id).toBe("cp-1");
    expect(result.projectId).toBe("proj-1");
    expect(result.title).toBe("前端完成");
    expect(result.goal).toBe("完成登录页");
    expect(result.completedSummary).toBeNull();
    expect(result.createdAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("update() 可更新 title + goal", async () => {
    rows["checkpoints"] = [{
      id: "cp-1", project_id: "proj-1", title: "前端完成 v2",
      goal: "完成登录页 + 注册页", completed_summary: null, current_context: null,
      decisions: null, failed_attempts: null, blockers: null, next_steps: null,
      do_not_repeat: null, acceptance_criteria: null,
      created_by_model_id: null, created_at: "2024-01-01T00:00:00.000Z",
    }];
    const result = await checkpoints.update("cp-1", { title: "前端完成 v2", goal: "完成登录页 + 注册页" });
    expect(mockDb.execute).toHaveBeenCalled();
    expect(result.title).toBe("前端完成 v2");
    expect(result.goal).toBe("完成登录页 + 注册页");
  });
});

describe("handoffPackets", () => {
  beforeEach(() => {
    rows["checkpoints"] = [];
    rows["handoff_packets"] = [];
    vi.clearAllMocks();
    mockDb.execute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 1 });
    mockDb.select.mockImplementation(async <T>(sql: string) => {
      if (sql.includes("FROM checkpoints")) return rows["checkpoints"] as T ?? ([] as unknown as T);
      if (sql.includes("FROM handoff_packets")) return rows["handoff_packets"] as T ?? ([] as unknown as T);
      return [] as unknown as T;
    });
  });

  it("renderHandoffMarkdown() 输出含 9 个二级标题 + 目标角色", () => {
    const cp = {
      id: "cp-1", projectId: "proj-1", title: "前端完成",
      goal: "完成登录页", completedSummary: "已实现", currentContext: "需联调",
      decisions: "用 Tauri", failedAttempts: "用 Electron", blockers: "无",
      nextSteps: "对接口", doNotRepeat: "不要把 API key 提交",
      acceptanceCriteria: "能登录",
      createdByModelId: null, createdAt: "2024-01-01T00:00:00.000Z",
    };
    // mock t: 返回 i18nKey 对应的原中文 label（验证 v0.6 行为）
    const tMock = (k: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        "handoffMarkdown.title": `接力包 → ${opts?.role ?? ""}`,
        "handoffMarkdown.sourceCheckpoint": `_原检查点：${opts?.title ?? ""}_`,
        "handoffMarkdown.generatedAt": `_生成时间：${opts?.time ?? ""}_`,
        "handoffMarkdown.empty": "（未填）",
        "projectDetail.fields.goal": "目标（Goal）",
        "projectDetail.fields.completedSummary": "已完成（Completed Summary）",
        "projectDetail.fields.currentContext": "当前上下文（Current Context）",
        "projectDetail.fields.decisions": "决策记录（Decisions）",
        "projectDetail.fields.failedAttempts": "失败尝试（Failed Attempts）",
        "projectDetail.fields.blockers": "阻塞项（Blockers）",
        "projectDetail.fields.nextSteps": "下一步（Next Steps）",
        "projectDetail.fields.doNotRepeat": "禁止重复（Do Not Repeat）",
        "projectDetail.fields.acceptanceCriteria": "验收标准（Acceptance Criteria）",
      };
      return map[k] ?? k;
    };
    const md = renderHandoffMarkdown(cp, "backend", tMock);
    expect(md).toContain("# 接力包 → backend");
    expect(md).toContain("## 目标（Goal）");
    expect(md).toContain("## 已完成（Completed Summary）");
    expect(md).toContain("## 当前上下文（Current Context）");
    expect(md).toContain("## 决策记录（Decisions）");
    expect(md).toContain("## 失败尝试（Failed Attempts）");
    expect(md).toContain("## 阻塞项（Blockers）");
    expect(md).toContain("## 下一步（Next Steps）");
    expect(md).toContain("## 禁止重复（Do Not Repeat）");
    expect(md).toContain("## 验收标准（Acceptance Criteria）");
    expect(md).toContain("完成登录页");
    expect(md).toContain("用 Tauri");
  });

  it("renderHandoffMarkdown() 字段为 null 时显示『（未填）』", () => {
    const cp = {
      id: "cp-1", projectId: "proj-1", title: "空白",
      goal: null, completedSummary: null, currentContext: null,
      decisions: null, failedAttempts: null, blockers: null, nextSteps: null,
      doNotRepeat: null, acceptanceCriteria: null,
      createdByModelId: null, createdAt: "2024-01-01T00:00:00.000Z",
    };
    const md = renderHandoffMarkdown(cp, "frontend", (k: string) => {
      const map: Record<string, string> = {
        "handoffMarkdown.title": "接力包 → {{role}}",
        "handoffMarkdown.sourceCheckpoint": "_原检查点：{{title}}_",
        "handoffMarkdown.generatedAt": "_生成时间：{{time}}_",
        "handoffMarkdown.empty": "（未填）",
        "projectDetail.fields.goal": "目标（Goal）",
        "projectDetail.fields.completedSummary": "已完成（Completed Summary）",
        "projectDetail.fields.currentContext": "当前上下文（Current Context）",
        "projectDetail.fields.decisions": "决策记录（Decisions）",
        "projectDetail.fields.failedAttempts": "失败尝试（Failed Attempts）",
        "projectDetail.fields.blockers": "阻塞项（Blockers）",
        "projectDetail.fields.nextSteps": "下一步（Next Steps）",
        "projectDetail.fields.doNotRepeat": "禁止重复（Do Not Repeat）",
        "projectDetail.fields.acceptanceCriteria": "验收标准（Acceptance Criteria）",
      };
      return map[k] ?? k;
    });
    expect(md).toContain("（未填）");
  });

  it("generate() 把 checkpoint 字段拼成 markdown 并存一条 handoff_packet", async () => {
    const cpRow = {
      id: "cp-1", project_id: "proj-1", title: "前端完成",
      goal: "完成登录页", completed_summary: null, current_context: null,
      decisions: null, failed_attempts: null, blockers: null, next_steps: null,
      do_not_repeat: null, acceptance_criteria: null,
      created_by_model_id: null, created_at: "2024-01-01T00:00:00.000Z",
    };
    rows["checkpoints"] = [cpRow];
    rows["handoff_packets"] = [];

    await handoffPackets.generate("cp-1", "backend", (k: string, opts?: Record<string, unknown>) => {
      if (k === "handoffMarkdown.title") return `接力包 → ${opts?.role ?? ""}`;
      if (k === "handoffMarkdown.sourceCheckpoint") return `_原检查点：${opts?.title ?? ""}_`;
      if (k === "handoffMarkdown.generatedAt") return `_生成时间：${opts?.time ?? ""}_`;
      if (k === "handoffMarkdown.empty") return "（未填）";
      if (k.startsWith("projectDetail.fields.")) return k;
      return k;
    });

    // execute 至少被调一次（INSERT INTO handoff_packets）
    expect(mockDb.execute).toHaveBeenCalled();
    const lastCall = mockDb.execute.mock.calls[mockDb.execute.mock.calls.length - 1] as unknown as unknown[] | undefined;
    const params = lastCall?.[1] as unknown[] | undefined;
    // 第 7 个参数是 content（id, project_id, checkpoint_id, target_role, target_model_id, format, content）
    const content = params?.[6] as string | undefined;
    expect(content).toContain("# 接力包 → backend");
    expect(content).toContain("完成登录页");
  });

  it("generate() checkpoint 不存在时抛错", async () => {
    rows["checkpoints"] = [];
    await expect(handoffPackets.generate("nope", "backend", (k: string) => k)).rejects.toThrow(/checkpoint nope not found/);
  });

  it("listByProject() 返回项目下的所有接力包", async () => {
    rows["handoff_packets"] = [
      { id: "hf-1", project_id: "proj-1", checkpoint_id: "cp-1", target_role: "backend", target_model_id: null, format: "markdown", content: "x", created_at: "2024-01-01T00:00:00.000Z" },
      { id: "hf-2", project_id: "proj-1", checkpoint_id: "cp-2", target_role: "testing", target_model_id: null, format: "markdown", content: "y", created_at: "2024-01-02T00:00:00.000Z" },
    ];
    const result = await handoffPackets.listByProject("proj-1");
    expect(result).toHaveLength(2);
    expect(result[0]!.targetRole).toBe("backend");
    expect(result[1]!.targetRole).toBe("testing");
  });
});
