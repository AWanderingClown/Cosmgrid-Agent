import { describe, it, expect } from "vitest";
import { buildTimePreamble, buildNoToolsPreamble } from "../context-preamble";

describe("buildTimePreamble", () => {
  it("用固定时间格式化出年月日 + 星期 + 时分", () => {
    // 2026-06-23 是星期二，14:05
    const now = new Date(2026, 5, 23, 14, 5);
    const out = buildTimePreamble(now);
    expect(out).toContain("2026-06-23");
    expect(out).toContain("星期二");
    expect(out).toContain("14:05");
  });

  it("个位数月/日/时/分补零", () => {
    // 2026-01-02 03:04（周五）
    const now = new Date(2026, 0, 2, 3, 4);
    const out = buildTimePreamble(now);
    expect(out).toContain("2026-01-02");
    expect(out).toContain("03:04");
  });

  it("每个星期几都映射正确", () => {
    const expected = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    // 2026-06-21 是星期日，连续 7 天覆盖一整周
    for (let i = 0; i < 7; i++) {
      const out = buildTimePreamble(new Date(2026, 5, 21 + i, 12, 0));
      expect(out).toContain(expected[i]);
    }
  });

  it("含给模型的指引语，不要瞎猜", () => {
    const out = buildTimePreamble(new Date(2026, 5, 23, 0, 0));
    expect(out).toContain("以此为准");
  });

  it("默认参数用当前时间，能正常生成", () => {
    const out = buildTimePreamble();
    expect(out).toMatch(/当前时间：\d{4}-\d{2}-\d{2} 星期[日一二三四五六] \d{2}:\d{2}/);
  });
});

describe("buildNoToolsPreamble", () => {
  it("明确告知模型没有工具/函数能力", () => {
    const out = buildNoToolsPreamble();
    expect(out).toContain("没有");
    expect(out).toMatch(/工具|函数/);
  });

  it("要求模型用纯文字回答", () => {
    const out = buildNoToolsPreamble();
    expect(out).toContain("纯文字");
  });

  it("列出禁止输出的伪工具调用格式，覆盖刷屏实际出现的标签", () => {
    const out = buildNoToolsPreamble();
    // 这三个是 DB 里 M3 实际吐过的伪工具调用标签名
    expect(out).toContain("<run_command>");
    expect(out).toContain("<view_file>");
    expect(out).toContain("<update_plan>");
    expect(out).toContain("<tool>");
    expect(out).toContain("arguments");
  });

  it("要求无法完成时用文字说明，不假装调用工具", () => {
    const out = buildNoToolsPreamble();
    expect(out).toContain("不要假装");
  });

  it("无参纯函数，每次返回同一段固定文本", () => {
    expect(buildNoToolsPreamble()).toBe(buildNoToolsPreamble());
    expect(typeof buildNoToolsPreamble()).toBe("string");
  });
});
