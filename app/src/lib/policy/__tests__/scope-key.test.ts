import { describe, it, expect } from "vitest";

import {
  GLOBAL_SCOPE_ID,
  keyToScope,
  scopeToKey,
} from "@/lib/policy/scope-key";
import type { PolicyScope } from "@/lib/policy/types";

describe("policy/scope-key", () => {
  describe("scopeToKey", () => {
    it("project scope 编码为 (project, projectId)", () => {
      const scope: PolicyScope = { level: "project", projectId: "proj-42" };
      expect(scopeToKey(scope)).toEqual({ level: "project", id: "proj-42" });
    });

    it("global scope 编码为 (global, __global__) sentinel", () => {
      expect(scopeToKey({ level: "global" })).toEqual({
        level: "global",
        id: GLOBAL_SCOPE_ID,
      });
      expect(GLOBAL_SCOPE_ID).toBe("__global__");
    });

    it("distribution stable 编码为 (distribution, stable)", () => {
      expect(scopeToKey({ level: "distribution", channel: "stable" })).toEqual({
        level: "distribution",
        id: "stable",
      });
    });

    it("distribution dev 编码为 (distribution, dev)", () => {
      expect(scopeToKey({ level: "distribution", channel: "dev" })).toEqual({
        level: "distribution",
        id: "dev",
      });
    });
  });

  describe("keyToScope", () => {
    it("反向解 project", () => {
      expect(keyToScope("project", "proj-1")).toEqual({
        level: "project",
        projectId: "proj-1",
      });
    });

    it("反向解 global（无论 sentinel 值）", () => {
      expect(keyToScope("global", GLOBAL_SCOPE_ID)).toEqual({ level: "global" });
    });

    it("反向解 distribution stable / dev", () => {
      expect(keyToScope("distribution", "stable")).toEqual({
        level: "distribution",
        channel: "stable",
      });
      expect(keyToScope("distribution", "dev")).toEqual({
        level: "distribution",
        channel: "dev",
      });
    });

    it("distribution 未知 channel id 回退到 stable，避免脏数据崩溃", () => {
      expect(keyToScope("distribution", "garbage")).toEqual({
        level: "distribution",
        channel: "stable",
      });
    });

    it("往返：scopeToKey → keyToScope 应等于原 scope", () => {
      const cases: PolicyScope[] = [
        { level: "project", projectId: "abc" },
        { level: "global" },
        { level: "distribution", channel: "stable" },
        { level: "distribution", channel: "dev" },
      ];
      for (const original of cases) {
        const { level, id } = scopeToKey(original);
        expect(keyToScope(level, id)).toEqual(original);
      }
    });
  });
});
