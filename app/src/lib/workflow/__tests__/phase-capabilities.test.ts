import { describe, it, expect } from "vitest";
import { capabilitiesForPhase } from "../phase-capabilities";

describe("capabilitiesForPhase（阶段能力策略，K7 供数源）", () => {
  it("read_project / plan：只读 + 只读命令，不给写", () => {
    for (const phase of ["read_project", "plan"] as const) {
      const caps = capabilitiesForPhase(phase);
      expect(caps).toContain("read_files");
      expect(caps).toContain("inspect_git");
      expect(caps).not.toContain("edit_files");
      expect(caps).not.toContain("update_docs");
    }
  });

  it("execute：给写 + 跑测试", () => {
    const caps = capabilitiesForPhase("execute");
    expect(caps).toContain("edit_files");
    expect(caps).toContain("run_tests");
    expect(caps).toContain("update_docs");
  });

  it("verify：给跑命令，不给写", () => {
    const caps = capabilitiesForPhase("verify");
    expect(caps).toContain("run_tests");
    expect(caps).toContain("run_build");
    expect(caps).not.toContain("edit_files");
  });

  it("review / debate / null / undefined：空数组（不门控，与旧行为一致）", () => {
    expect(capabilitiesForPhase("review")).toEqual([]);
    expect(capabilitiesForPhase("debate")).toEqual([]);
    expect(capabilitiesForPhase(null)).toEqual([]);
    expect(capabilitiesForPhase(undefined)).toEqual([]);
  });
});
