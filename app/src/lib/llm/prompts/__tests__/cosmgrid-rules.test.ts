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

describe("COSMGRID_RULES（怎么干活：说了要做就必须真调用工具）", () => {
  // 对齐 OpenCode 等成熟项目的做法（system prompt 硬约束防"嘴炮"，而非只靠运行时检测），
  // 见 harness-nudge-toolchoice-required 记忆。
  it("包含'打算做≠做完了'的硬约束", () => {
    expect(COSMGRID_RULES).toContain("等于没做");
  });

  it("用户要求开始执行时，不把阶段审计变成新的确认点", () => {
    expect(COSMGRID_RULES).toContain("开始执行");
    expect(COSMGRID_RULES).toContain("不要在每个阶段结束后停下来等用户确认");
  });

  it("按既定方案执行前，要求先读取方案产物而不是凭记忆猜", () => {
    expect(COSMGRID_RULES).toContain("之前那个方案");
    expect(COSMGRID_RULES).toContain("先读取明确存在的方案文件");
    expect(COSMGRID_RULES).toContain("不要凭聊天记忆猜");
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
