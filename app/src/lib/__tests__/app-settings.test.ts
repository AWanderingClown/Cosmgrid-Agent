// app-settings 单测（v0.9 阶段7：智能路由开关）
import { describe, it, expect, beforeEach } from "vitest";

// node 环境无 localStorage，注入内存 stub
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

import { isSmartRoutingEnabled, setSmartRoutingEnabled } from "../app-settings";

describe("智能路由开关", () => {
  beforeEach(() => store.clear());

  it("默认开启（未设置过）", () => {
    expect(isSmartRoutingEnabled()).toBe(true);
  });

  it("显式关闭后为 false", () => {
    setSmartRoutingEnabled(false);
    expect(isSmartRoutingEnabled()).toBe(false);
  });

  it("关闭后再开启为 true", () => {
    setSmartRoutingEnabled(false);
    setSmartRoutingEnabled(true);
    expect(isSmartRoutingEnabled()).toBe(true);
  });
});
