import { describe, expect, it } from "vitest";
import { COSMGRID_RULES, COSMGRID_TONE_RULES, buildIdentityLine } from "../cosmgrid-rules";

describe("COSMGRID_TONE_RULES（从 CosmGrid.md 摘取的'怎么说话'一段）", () => {
  it("摘出的内容包含语气规则关键句", () => {
    expect(COSMGRID_TONE_RULES).toContain("不要奉承附和");
  });

  it("不包含其他段落（用户是谁/怎么干活）的内容，确认按标题切段没有切漏边界", () => {
    expect(COSMGRID_TONE_RULES).not.toContain("vibe coder");
    expect(COSMGRID_TONE_RULES).not.toContain("grep 工具");
  });

  it("是完整规则文本 COSMGRID_RULES 的子集", () => {
    expect(COSMGRID_RULES).toContain(COSMGRID_TONE_RULES);
  });
});

describe("buildIdentityLine", () => {
  it("不传 driverLabel 时不含'当前由...驱动'", () => {
    expect(buildIdentityLine()).not.toContain("驱动");
  });

  it("传 driverLabel 时带出该模型名", () => {
    expect(buildIdentityLine("MiniMax-M3")).toContain("当前由 MiniMax-M3 驱动");
  });
});
