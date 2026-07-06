import { describe, expect, it, vi } from "vitest";
import { isBusyError, withBusyRetry } from "../connection";

describe("isBusyError", () => {
  it("识别 database is locked", () => {
    expect(isBusyError(new Error("database is locked"))).toBe(true);
  });

  it("识别 SQLITE_BUSY", () => {
    expect(isBusyError(new Error("code: SQLITE_BUSY: database is locked"))).toBe(true);
  });

  it("大小写不敏感", () => {
    expect(isBusyError(new Error("Database Is Locked"))).toBe(true);
  });

  it("语法错误等其他错误不算 busy", () => {
    expect(isBusyError(new Error("syntax error near SELECT"))).toBe(false);
  });

  it("非 Error 对象也能处理（走 String() 兜底）", () => {
    expect(isBusyError("database is locked")).toBe(true);
    expect(isBusyError({ weird: true })).toBe(false);
  });
});

// 真实事故（2026-07-05）：tauri-plugin-sql 底层是 sqlx 连接池（非单连接），journal_mode
// 会落盘对全池生效，但 busy_timeout 是连接级设置——池子并发扩容出的新连接默认没有
// busy_timeout，一遇锁冲突立刻报错。withBusyRetry 在 JS 层补齐这个行为：遇到 busy 错误
// 退避重试，而不是让调用方（如"归档对话"）直接看到一次性失败。
describe("withBusyRetry", () => {
  it("成功不重试，直接返回", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withBusyRetry(fn, [1, 1, 1]);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("busy 错误重试几次后成功 → 返回成功结果", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("database is locked"))
      .mockRejectedValueOnce(new Error("database is locked"))
      .mockResolvedValueOnce("recovered");
    const result = await withBusyRetry(fn, [1, 1, 1]);
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("非 busy 错误立即抛出，不重试", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("constraint failed"));
    await expect(withBusyRetry(fn, [1, 1, 1])).rejects.toThrow("constraint failed");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("重试次数用尽仍然 busy → 最终原样抛出最后一次的错误", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("database is locked"));
    await expect(withBusyRetry(fn, [1, 1])).rejects.toThrow("database is locked");
    expect(fn).toHaveBeenCalledTimes(3); // 首次 + 2 次重试
  });
});
