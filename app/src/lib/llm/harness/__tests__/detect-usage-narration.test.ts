import { describe, it, expect } from "vitest";
import { extractClaimedUsageCounts, detectFabricatedUsageCount } from "../detect-usage-narration";

describe("extractClaimedUsageCounts", () => {
  it("抓到英文 'Ran N commands'", () => {
    expect(extractClaimedUsageCounts("Ran 2 commands")).toEqual([2]);
  });
  it("抓到英文 'Used N tools'", () => {
    expect(extractClaimedUsageCounts("Used 5 tools")).toEqual([5]);
  });
  it("抓到中文 '调用了N个工具'", () => {
    expect(extractClaimedUsageCounts("调用了5个工具")).toEqual([5]);
  });
  it("抓到中文 '执行了N次命令'", () => {
    expect(extractClaimedUsageCounts("执行了2次命令")).toEqual([2]);
  });
  it("同一段落多处声称 → 全部抓到", () => {
    expect(extractClaimedUsageCounts("Ran 2 commands。Used 5 tools。")).toEqual([2, 5]);
  });
  it("纯数字提及但无使用动词前缀 → 不抓（避免误伤'第5个服务'这类无关数字）", () => {
    expect(extractClaimedUsageCounts("现在开始加第5个服务")).toEqual([]);
  });
  it("无声称 → 空数组", () => {
    expect(extractClaimedUsageCounts("你好，今天天气不错")).toEqual([]);
  });
});

describe("detectFabricatedUsageCount", () => {
  it("声称次数 > 实际 toolCallCount(0) → 判定编造", () => {
    expect(detectFabricatedUsageCount("Ran 2 commands", 0)).toBe(2);
  });
  it("声称次数 > 实际 toolCallCount(1) → 判定编造，取最大声称值", () => {
    expect(detectFabricatedUsageCount("先 Ran 2 commands，然后 Used 5 tools", 1)).toBe(5);
  });
  it("声称次数 <= 实际 toolCallCount → 不判定编造（正常复述）", () => {
    expect(detectFabricatedUsageCount("我调用了2个工具", 2)).toBeNull();
    expect(detectFabricatedUsageCount("我调用了2个工具", 3)).toBeNull();
  });
  it("无使用次数声称 → 不判定编造", () => {
    expect(detectFabricatedUsageCount("你好，今天天气不错", 0)).toBeNull();
  });
});
