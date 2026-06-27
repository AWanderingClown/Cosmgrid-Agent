import { describe, it, expect } from "vitest";
import { detectDoomLoop, type StepToolCall } from "../doom-loop";

const tc = (toolName: string, input: unknown): StepToolCall => ({ toolName, input });

describe("detectDoomLoop", () => {
  it("连续 3 次相同工具+相同参数 → 命中", () => {
    const steps = [tc("read", { p: "/a" }), tc("read", { p: "/a" }), tc("read", { p: "/a" })];
    expect(detectDoomLoop(steps)).toBe(true);
  });

  it("2 次相同 + 1 次不同 → 不命中", () => {
    const steps = [tc("read", { p: "/a" }), tc("read", { p: "/a" }), tc("read", { p: "/b" })];
    expect(detectDoomLoop(steps)).toBe(false);
  });

  it("工具名相同但参数不同 → 不命中", () => {
    const steps = [tc("read", { p: "/a" }), tc("read", { p: "/b" }), tc("read", { p: "/c" })];
    expect(detectDoomLoop(steps)).toBe(false);
  });

  it("不足 threshold 次 → 不命中", () => {
    expect(detectDoomLoop([tc("read", { p: "/a" }), tc("read", { p: "/a" })])).toBe(false);
  });

  it("最后 3 次相同即可（前面不同不影响）", () => {
    const steps = [tc("glob", { p: "*" }), tc("read", { p: "/a" }), tc("read", { p: "/a" }), tc("read", { p: "/a" })];
    expect(detectDoomLoop(steps)).toBe(true);
  });

  it("自定义 threshold", () => {
    const steps = [tc("read", 1), tc("read", 1)];
    expect(detectDoomLoop(steps, 2)).toBe(true);
  });
});
