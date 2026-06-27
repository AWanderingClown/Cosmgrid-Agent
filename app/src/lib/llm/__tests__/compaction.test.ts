import { describe, it, expect } from "vitest";
import { slidingWindowCompact, type CompactMessage } from "../compaction";

const m = (role: CompactMessage["role"], content: string): CompactMessage => ({ role, content });

describe("slidingWindowCompact", () => {
  it("不足 keepRecent 条 → 原样返回", () => {
    const msgs = [m("user", "1"), m("assistant", "2"), m("user", "3")];
    expect(slidingWindowCompact(msgs, { keepRecent: 6 })).toEqual(msgs);
  });

  it("超过 keepRecent → 保留 system + 最近 N + 折叠摘要", () => {
    const msgs = [
      m("system", "时间"),
      m("user", "1"), m("assistant", "2"), m("user", "3"),
      m("assistant", "4"), m("user", "5"), m("assistant", "6"),
      m("user", "7"), m("assistant", "8"),
    ];
    const out = slidingWindowCompact(msgs, { keepRecent: 4 });
    // system 保留 + 摘要 + 最近 4 条
    expect(out[0]).toEqual(m("system", "时间"));
    expect(out[1]?.role).toBe("system");
    expect(out[1]?.content).toContain("已折叠 4 条");
    expect(out.slice(-4).map((x) => x.content)).toEqual(["5", "6", "7", "8"]);
  });

  it("多个 system 全保留", () => {
    const msgs = [
      m("system", "a"), m("system", "b"),
      m("user", "1"), m("assistant", "2"), m("user", "3"), m("assistant", "4"), m("user", "5"),
    ];
    const out = slidingWindowCompact(msgs, { keepRecent: 2 });
    expect(out.filter((x) => x.role === "system" && x.content !== out[2]?.content)).toHaveLength(2);
  });

  it("默认 keepRecent=6", () => {
    const msgs = Array.from({ length: 10 }, (_, i) => m(i % 2 ? "assistant" : "user", String(i)));
    const out = slidingWindowCompact(msgs);
    // 10 条非 system > 6 → 折叠，保留最近 6
    expect(out.slice(-6).map((x) => x.content)).toEqual(["4", "5", "6", "7", "8", "9"]);
  });
});
