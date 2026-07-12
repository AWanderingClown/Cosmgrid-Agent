import { describe, it, expect, beforeEach, vi } from "vitest";

import { PolicyStore, PolicyStoreError } from "@/lib/policy/policy-store";
import { scopeToKey } from "@/lib/policy/scope-key";
import type { PolicyScope } from "@/lib/policy/types";

// ---------- 测试用假 DAO，避免依赖真 DB ----------

type ScopeSlot = string; // `${level}|${id}`

interface FakeOverrideRow {
  policyKey: string;
  scopeLevel: "project" | "global" | "distribution";
  scopeId: string;
  valueJson: string;
  builtinVersion: string;
  updatedAt: string;
  updatedBy: string | null;
}

function slot(scope: PolicyScope): ScopeSlot {
  const { level, id } = scopeToKey(scope);
  return `${level}|${id}`;
}

function makeFakeOverrides() {
  const rows = new Map<string, FakeOverrideRow>();

  return {
    rows,
    async get(policyKey: string, scope: PolicyScope) {
      return rows.get(`${policyKey}::${slot(scope)}`) ?? null;
    },
    async set(input: {
      policyKey: string;
      scope: PolicyScope;
      valueJson: string;
      builtinVersion: string;
      actor?: string | null;
    }) {
      const { level, id } = scopeToKey(input.scope);
      const row: FakeOverrideRow = {
        policyKey: input.policyKey,
        scopeLevel: level,
        scopeId: id,
        valueJson: input.valueJson,
        builtinVersion: input.builtinVersion,
        updatedAt: "2026-07-12T00:00:00.000Z",
        updatedBy: input.actor ?? null,
      };
      rows.set(`${input.policyKey}::${slot(input.scope)}`, row);
      // 返回 setting 后的 row（仿 DAO 行为）
      return {
        policyKey: row.policyKey,
        scopeLevel: row.scopeLevel,
        scopeId: row.scopeId,
        scope: input.scope,
        valueJson: row.valueJson,
        builtinVersion: row.builtinVersion,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      };
    },
    async clear(policyKey: string, scope: PolicyScope) {
      const k = `${policyKey}::${slot(scope)}`;
      const existed = rows.get(k);
      if (!existed) return false;
      rows.delete(k);
      return true;
    },
    async clearAllForPolicy(policyKey: string) {
      const matches: FakeOverrideRow[] = [];
      for (const [k, v] of rows.entries()) {
        if (k.startsWith(`${policyKey}::`)) {
          matches.push(v);
          rows.delete(k);
        }
      }
      return matches;
    },
    async listByPolicy(policyKey: string) {
      const out: FakeOverrideRow[] = [];
      for (const [k, v] of rows.entries()) {
        if (k.startsWith(`${policyKey}::`)) out.push(v);
      }
      return out;
    },
    async listKeysWithOverrides() {
      return [...new Set([...rows.keys()].map((k) => k.split("::")[0]!))];
    },
  };
}

function makeFakeHistory() {
  const calls: Array<{
    policyKey: string;
    scope: PolicyScope;
    action: "set" | "clear" | "bulk_clear";
    oldValueJson: string | null;
    newValueJson: string | null;
    actor: string | null;
  }> = [];

  return {
    calls,
    async record(input: {
      policyKey: string;
      scope: PolicyScope;
      action: "set" | "clear" | "bulk_clear";
      oldValueJson?: string | null;
      newValueJson?: string | null;
      actor?: string | null;
    }) {
      calls.push({
        policyKey: input.policyKey,
        scope: input.scope,
        action: input.action,
        oldValueJson: input.oldValueJson ?? null,
        newValueJson: input.newValueJson ?? null,
        actor: input.actor ?? null,
      });
    },
    async listByPolicy() {
      return [];
    },
  };
}

// ---------- 测试用例 ----------

describe("policy/policy-store", () => {
  let store: PolicyStore;
  let overrides: ReturnType<typeof makeFakeOverrides>;
  let history: ReturnType<typeof makeFakeHistory>;

  beforeEach(() => {
    overrides = makeFakeOverrides();
    history = makeFakeHistory();
    store = new PolicyStore({
      overrides: overrides as any,
      history: history as any,
    });
  });

  describe("set/get roundtrip", () => {
    it("set 后 get 能拿到 raw value_json", async () => {
      await store.set(
        "command.allowed_programs",
        { level: "global" },
        '["custom-tool"]',
        "tester",
      );
      const got = await store.get("command.allowed_programs", { level: "global" });
      expect(got).toBe('["custom-tool"]');
    });

    it("无 override 时 get 返回 null", async () => {
      const got = await store.get("command.allowed_programs", {
        level: "project",
        projectId: "p1",
      });
      expect(got).toBeNull();
    });

    it("不同 scope 互不干扰", async () => {
      await store.set("k", { level: "global" }, '"a"', "t");
      await store.set("k", { level: "project", projectId: "p1" }, '"b"', "t");
      expect(await store.get("k", { level: "global" })).toBe('"a"');
      expect(await store.get("k", { level: "project", projectId: "p1" })).toBe('"b"');
      expect(await store.get("k", { level: "project", projectId: "p2" })).toBeNull();
    });

    it("set 触发 audit history (action='set')", async () => {
      await store.set("k", { level: "global" }, '"v1"', "alice");
      expect(history.calls).toHaveLength(1);
      expect(history.calls[0]).toMatchObject({
        policyKey: "k",
        scope: { level: "global" },
        action: "set",
        oldValueJson: null,
        newValueJson: '"v1"',
        actor: "alice",
      });
    });

    it("update set 时 audit 记录 oldValueJson", async () => {
      await store.set("k", { level: "global" }, '"v1"', "alice");
      await store.set("k", { level: "global" }, '"v2"', "alice");
      expect(history.calls).toHaveLength(2);
      expect(history.calls[1]!.oldValueJson).toBe('"v1"');
      expect(history.calls[1]!.newValueJson).toBe('"v2"');
    });
  });

  describe("RESERVED key 保护", () => {
    it("set RESERVED key 抛 PolicyStoreError RESERVED_KEY", async () => {
      await expect(
        store.set(
          "security.dangerous_patterns",
          { level: "global" },
          "[]",
          "hacker",
        ),
      ).rejects.toMatchObject({
        name: "PolicyStoreError",
        code: "RESERVED_KEY",
      });
      expect(overrides.rows.size).toBe(0);
      expect(history.calls).toHaveLength(0);
    });

    it("clear RESERVED key 也抛 RESERVED_KEY", async () => {
      await expect(
        store.clear("security.sensitive_paths", { level: "global" }),
      ).rejects.toMatchObject({ code: "RESERVED_KEY" });
    });

    it("reset RESERVED key 也抛 RESERVED_KEY", async () => {
      await expect(
        store.reset("security.ssrf_hosts", { level: "global" }),
      ).rejects.toMatchObject({ code: "RESERVED_KEY" });
    });
  });

  describe("JSON 校验", () => {
    it("不是合法 JSON 抛 INVALID_JSON", async () => {
      await expect(
        store.set("k", { level: "global" }, "not json", "t"),
      ).rejects.toMatchObject({ code: "INVALID_JSON" });
    });

    it("合法 JSON（任意结构）可写，校验交给 PolicyDefinition.parse", async () => {
      await expect(
        store.set("k", { level: "global" }, '{"a":1,"b":[2,3]}', "t"),
      ).resolves.toBeUndefined();
    });
  });

  describe("clear", () => {
    it("存在 override 时清除并 audit", async () => {
      await store.set("k", { level: "global" }, '"v"', "t");
      history.calls.length = 0;
      await store.clear("k", { level: "global" }, "t");
      expect(await store.get("k", { level: "global" })).toBeNull();
      expect(history.calls[0]).toMatchObject({
        action: "clear",
        oldValueJson: '"v"',
        newValueJson: null,
      });
    });

    it("无 override 时 clear 是 no-op（不写 audit）", async () => {
      await store.clear("k", { level: "global" }, "t");
      expect(await store.get("k", { level: "global" })).toBeNull();
      expect(history.calls).toHaveLength(0);
    });
  });

  describe("reset (K3 cascade 语义)", () => {
    it("project scope reset 只清本项目，不动全局和其他项目", async () => {
      await store.set("k", { level: "global" }, '"g"', "t");
      await store.set("k", { level: "project", projectId: "p1" }, '"1"', "t");
      await store.set("k", { level: "project", projectId: "p2" }, '"2"', "t");

      await store.reset("k", { level: "project", projectId: "p1" }, "t");

      // p1 清掉；global / p2 在
      expect(await store.get("k", { level: "project", projectId: "p1" })).toBeNull();
      expect(await store.get("k", { level: "project", projectId: "p2" })).toBe('"2"');
      expect(await store.get("k", { level: "global" })).toBe('"g"');
    });

    it("global scope reset 级联清全部 override（global + 所有 project）", async () => {
      await store.set("k", { level: "global" }, '"g"', "t");
      await store.set("k", { level: "project", projectId: "p1" }, '"1"', "t");
      await store.set("k", { level: "project", projectId: "p2" }, '"2"', "t");

      history.calls.length = 0;
      await store.reset("k", { level: "global" }, "t");

      expect(overrides.rows.size).toBe(0);
      // 三条 bulk_clear audit，每条对应一条被删 row
      expect(history.calls).toHaveLength(3);
      for (const call of history.calls) {
        expect(call.action).toBe("bulk_clear");
        expect(call.newValueJson).toBeNull();
      }
    });

    it("global reset 在没有 override 时是 no-op（不写 audit）", async () => {
      await store.reset("k", { level: "global" }, "t");
      expect(history.calls).toHaveLength(0);
    });

    it("distribution scope reset 抛 NOT_RESETTABLE", async () => {
      await expect(
        store.reset("k", { level: "distribution", channel: "stable" }, "t"),
      ).rejects.toMatchObject({ code: "NOT_RESETTABLE" });
    });
  });

  describe("history / listConfiguredKeys / listOverrides", () => {
    it("history 委托给 history.listByPolicy", async () => {
      const spy = vi.spyOn(history, "listByPolicy");
      await store.history("command.allowed_programs", 10);
      expect(spy).toHaveBeenCalledWith("command.allowed_programs", 10);
    });

    it("listConfiguredKeys 返回所有用过 override 的 key", async () => {
      await store.set("k1", { level: "global" }, '"x"', "t");
      await store.set("k2", { level: "project", projectId: "p" }, '"y"', "t");
      const keys = await store.listConfiguredKeys();
      expect(keys.sort()).toEqual(["k1", "k2"]);
    });
  });

  describe("PolicyStoreError 类型契约", () => {
    it("instanceof Error = true", () => {
      const e = new PolicyStoreError("test", "RESERVED_KEY");
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(PolicyStoreError);
      expect(e.name).toBe("PolicyStoreError");
      expect(e.code).toBe("RESERVED_KEY");
    });
  });

  describe("audit 失败不阻断主路径", () => {
    it("history.record 抛错时 set 仍成功", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const originalRecord = history.record;
      history.record = vi.fn(async () => {
        throw new Error("audit table missing");
      }) as any;
      await expect(
        store.set("k", { level: "global" }, '"v"', "t"),
      ).resolves.toBeUndefined();
      expect(consoleSpy).toHaveBeenCalled();
      history.record = originalRecord;
      consoleSpy.mockRestore();
    });
  });
});
