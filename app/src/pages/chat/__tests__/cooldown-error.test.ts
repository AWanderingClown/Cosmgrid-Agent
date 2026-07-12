import { describe, expect, it } from "vitest";
import {
  formatCooldownCountdownMessage,
  formatCooldownRemaining,
  parseCooldownCountdownMessage,
} from "../cooldown-error";

describe("cooldown error countdown", () => {
  it("解析分钟级全员冷却错误，并按 elapsed 生成倒计时文案", () => {
    const parsed = parseCooldownCountdownMessage(
      "所有可用模型目前都在冷却中：MiniMax-M3（还需 5 分钟）、Kimi（还需 1 分钟）。倒计时结束后可以继续发送",
    );

    expect(parsed).toEqual({
      entries: [
        { modelName: "MiniMax-M3", remainingMs: 300_000 },
        { modelName: "Kimi", remainingMs: 60_000 },
      ],
    });
    expect(formatCooldownCountdownMessage(parsed!, 61_000)).toBe(
      "所有可用模型目前都在冷却中：MiniMax-M3（还需 3 分 59 秒）。倒计时结束后可以继续发送",
    );
  });

  it("解析分钟加秒，倒计时结束后提示可重试", () => {
    const parsed = parseCooldownCountdownMessage("所有可用模型目前都在冷却中：MiniMax-M3（还需 1 分 5 秒）。");

    expect(parsed?.entries[0]).toEqual({ modelName: "MiniMax-M3", remainingMs: 65_000 });
    expect(formatCooldownCountdownMessage(parsed!, 65_000)).toBe("模型冷却已结束，可以重试了。");
  });

  it("普通错误不进入倒计时分支", () => {
    expect(parseCooldownCountdownMessage("网络连接失败，请检查网络或 Base URL 配置")).toBeNull();
  });

  it("剩余时间格式对齐中文显示", () => {
    expect(formatCooldownRemaining(121_000)).toBe("2 分 1 秒");
    expect(formatCooldownRemaining(60_000)).toBe("1 分钟");
    expect(formatCooldownRemaining(8_200)).toBe("9 秒");
  });
});
