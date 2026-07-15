import { describe, it, expect } from "vitest";
import { guidanceForPhase } from "../phase-guidance";

describe("guidanceForPhase（阶段行为纪律，迁移自原 3 个内置 skill）", () => {
  it("read_project / plan：含原 project_audit 的核心纪律", () => {
    for (const phase of ["read_project", "plan"] as const) {
      const g = guidanceForPhase(phase);
      expect(g.some((x) => x.includes("先读取项目文件"))).toBe(true);
      expect(g.some((x) => x.includes("不要用模板化项目经验"))).toBe(true);
    }
  });

  it("execute：含原 plan_execution 的核心纪律 + 迁移前已存在的独立提醒（合并去重）", () => {
    const g = guidanceForPhase("execute");
    expect(g.some((x) => x.includes("先对齐方案来源"))).toBe(true);
    expect(g.some((x) => x.includes("不要每个阶段都停下来等用户确认"))).toBe(true);
    expect(g.some((x) => x.includes("真实文件改动或真实验证证据"))).toBe(true);
  });

  it("verify：含原 verification_closure 的核心纪律 + 4 条验收标准描述（尤其 lint 不能丢）", () => {
    const g = guidanceForPhase("verify");
    expect(g.some((x) => x.includes("不要把计划当结果"))).toBe(true);
    expect(g.some((x) => x.includes("发现失败时先定位原因"))).toBe(true);
    const criteria = g.find((x) => x.startsWith("验收标准："));
    expect(criteria).toBeDefined();
    expect(criteria).toContain("运行测试套件全部通过");
    expect(criteria).toContain("tsc --noEmit 通过");
    expect(criteria).toContain("ESLint 无 error");
    expect(criteria).toContain("构建无 error");
  });

  it("review / debate / null / undefined：空数组", () => {
    expect(guidanceForPhase("review")).toEqual([]);
    expect(guidanceForPhase("debate")).toEqual([]);
    expect(guidanceForPhase(null)).toEqual([]);
    expect(guidanceForPhase(undefined)).toEqual([]);
  });
});
