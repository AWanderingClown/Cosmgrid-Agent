import { describe, it, expect } from "vitest";

import {
  RESERVED_POLICY_KEYS,
  isReservedPolicyKey,
} from "@/lib/security-invariants";

describe("security-invariants", () => {
  describe("RESERVED_POLICY_KEYS", () => {
    it("是 frozen 数组（Object.freeze 生效）", () => {
      expect(Object.isFrozen(RESERVED_POLICY_KEYS)).toBe(true);
    });

    it("包含方案 §4.2 列出的全部安全红线 key", () => {
      expect(RESERVED_POLICY_KEYS).toContain("security.dangerous_patterns");
      expect(RESERVED_POLICY_KEYS).toContain("security.sensitive_paths");
      expect(RESERVED_POLICY_KEYS).toContain("security.ssrf_hosts");
      expect(RESERVED_POLICY_KEYS).toContain("security.api_key_patterns");
    });
  });

  describe("isReservedPolicyKey", () => {
    it("命中返回 true", () => {
      expect(isReservedPolicyKey("security.dangerous_patterns")).toBe(true);
      expect(isReservedPolicyKey("security.api_key_patterns")).toBe(true);
    });

    it("未命中返回 false", () => {
      expect(isReservedPolicyKey("command.allowed_programs")).toBe(false);
      expect(isReservedPolicyKey("message.router.hard_markers")).toBe(false);
      expect(isReservedPolicyKey("")).toBe(false);
    });
  });
});
