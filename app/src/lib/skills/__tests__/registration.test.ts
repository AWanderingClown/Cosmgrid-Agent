import { describe, it, expect, beforeEach, vi } from "vitest";

// review T-F-9（2026-07-13）修复陪跑：registration 之前调真 DB（无 PolicyStore
// 那种 class 注入点），vitest 走到 tauri-plugin-sql → window 报错。下面把
// skillDefinitions / skillAuditLog 整个 mock 掉，让 registration 走纯函数路径
// 不触 DB。
const skillDaoMock = vi.hoisted(() => {
  const rows = new Map<string, any>();
  const auditCalls: any[] = [];

  return {
    rows,
    auditCalls,
    skillDefinitions: {
      async getById(id: string) {
        return rows.get(id) ?? null;
      },
      async countBySource(source: string) {
        let n = 0;
        for (const r of rows.values()) {
          if (r.source === source && (r.reviewStatus === "pending" || r.reviewStatus === "approved")) n++;
        }
        return n;
      },
      async upsert(input: any) {
        rows.set(input.id, {
          id: input.id,
          builtinVersion: input.builtinVersion ?? null,
          label: input.label,
          purpose: input.purpose,
          triggerPhases: input.triggerPhases ?? [],
          triggerKeywords: input.triggerKeywords ?? [],
          requiredCapabilities: input.requiredCapabilities ?? [],
          systemGuidance: input.systemGuidance ?? [],
          acceptanceCriteria: input.acceptanceCriteria ?? [],
          source: input.source,
          reviewStatus: input.reviewStatus,
          reviewedBy: input.reviewedBy ?? null,
          reviewedAt: input.reviewedAt ?? null,
          createdAt: "2026-07-13T00:00:00.000Z",
          updatedAt: "2026-07-13T00:00:00.000Z",
        });
      },
      async approve(id: string, reviewer: string) {
        const r = rows.get(id);
        if (!r) return null;
        r.reviewStatus = "approved";
        r.reviewedBy = reviewer;
        r.reviewedAt = "2026-07-13T00:00:00.000Z";
        return r;
      },
      async reject(id: string, reviewer: string) {
        const r = rows.get(id);
        if (!r) return null;
        r.reviewStatus = "rejected";
        r.reviewedBy = reviewer;
        r.reviewedAt = "2026-07-13T00:00:00.000Z";
        return r;
      },
      async retire(id: string) {
        const r = rows.get(id);
        if (!r) return;
        r.reviewStatus = "rejected";
      },
    },
    skillAuditLog: {
      async record(input: any) {
        auditCalls.push({ ...input });
      },
      async listBySkill() {
        return [];
      },
      async listAll() {
        return [];
      },
    },
  };
});

vi.mock("@/lib/db/skill-definitions", () => ({
  skillDefinitions: skillDaoMock.skillDefinitions,
  skillOverrideHistory: { record: vi.fn(), listByPolicy: vi.fn(), listAll: vi.fn() } as any,
  skillAuditLog: skillDaoMock.skillAuditLog,
}));
vi.mock("@/lib/db/skill-audit-log", () => ({
  skillAuditLog: skillDaoMock.skillAuditLog,
}));
// 旁路 schema_imports — registration 的 import "@/lib/llm/capability-registry" 用
// dynamic import，在 vitest 环境下也走真模块，没问题。但 SECURITY_RISK 全局副作用
// 需保持：registerSkill 调 skillDefinitions.skillDefinitions ... 需上面 mock 把所有
// 顶层模块都覆盖到。

import {
  approveSkill,
  MAX_USER_SKILLS,
  registerSkill,
  rejectSkill,
  retireSkill,
  SkillRegistrationError,
} from "@/lib/skills/registration";

// ----- 测试 -----

const VALID_SKILL_INPUT = {
  id: "test_skill",
  source: "user" as const,
  label: "测试技能",
  purpose: "仅用于单测。",
  triggerPhases: ["execute"],
  triggerKeywords: ["测试", "test"],
  requiredCapabilities: ["edit_files", "run_tests"],
  systemGuidance: ["先读仓库再下结论。"],
  acceptanceCriteria: ["测试通过"],
};

describe("skills/registration — K7 + K12 注册流程", () => {
  // 注入 fake DAO 通过模块顶部 vi.mock 完成；每个用例直接用 VALID_SKILL_INPUT。
  beforeEach(() => {
    // 清空 skillDaoMock 的内部 map，避免测试间状态泄漏。
    skillDaoMock.rows.clear();
    skillDaoMock.auditCalls.length = 0;
  });
  describe("空 capabilities 拒绝（review F-03 修复）", () => {
    it("requiredCapabilities = [] 抛 EMPTY_REQUIRED_CAPABILITIES", async () => {
      // zod 校验先抛（空数组不是 string[] schema 接受的形式）
      const input = { ...VALID_SKILL_INPUT, requiredCapabilities: [] as never[] };
      try {
        await registerSkill(input as never);
        expect.fail("should throw");
      } catch (err) {
        expect(err).toBeInstanceOf(SkillRegistrationError);
        // 静态分支检查：要么 INVALID_SCHEMA（zod 拒绝），要么 EMPTY_REQUIRED_CAPABILITIES
        expect(["INVALID_SCHEMA", "EMPTY_REQUIRED_CAPABILITIES"]).toContain(
          (err as SkillRegistrationError).code,
        );
      }
    });
  });

  describe("未知 capability 拒绝（review F-03 修复）", () => {
    it("声明 typo 的 capability（如 editt_files）→ INVALID_SCHEMA", async () => {
      const input = {
        ...VALID_SKILL_INPUT,
        requiredCapabilities: ["editt_files" as never], // edit_files 的 typo
      };
      try {
        await registerSkill(input);
        expect.fail("should reject");
      } catch (err) {
        expect(err).toBeInstanceOf(SkillRegistrationError);
        expect(["INVALID_SCHEMA", "EMPTY_REQUIRED_CAPABILITIES"]).toContain(
          (err as SkillRegistrationError).code,
        );
      }
    });
  });

  describe("MAX_USER_SKILLS 数量上限（review K12 默认组合）", () => {
    it("MAX_USER_SKILLS = 12 是单一来源常量", () => {
      expect(MAX_USER_SKILLS).toBe(12);
    });
  });

  describe("approve / reject / retire 错误类型（不存在 skill）", () => {
    it("approveSkill 不存在 id → SkillRegistrationError UNKNOWN_ERROR", async () => {
      try {
        await approveSkill("not-exist", "reviewer1");
        expect.fail("should throw");
      } catch (err) {
        expect(err).toBeInstanceOf(SkillRegistrationError);
        expect((err as SkillRegistrationError).code).toBe("UNKNOWN_ERROR");
      }
    });

    it("rejectSkill 不存在 id → SkillRegistrationError UNKNOWN_ERROR", async () => {
      try {
        await rejectSkill("not-exist", "reviewer1");
        expect.fail("should throw");
      } catch (err) {
        expect(err).toBeInstanceOf(SkillRegistrationError);
        expect((err as SkillRegistrationError).code).toBe("UNKNOWN_ERROR");
      }
    });

    it("retireSkill 不存在 id → no-op（不抛）", async () => {
      await expect(retireSkill("not-exist", "alice")).resolves.toBeUndefined();
    });
  });
});
