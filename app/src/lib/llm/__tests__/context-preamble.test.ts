import { describe, it, expect } from "vitest";
import { buildTimePreamble, buildNoToolsPreamble, buildProjectMemoryPreamble, buildCrossProjectMemoryPreamble } from "../context-preamble";

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

describe("buildProjectMemoryPreamble", () => {
  it("无记忆时返回 null，避免白占 token", () => {
    expect(buildProjectMemoryPreamble("Cosmgrid", [])).toBeNull();
  });

  it("只描述当前项目记忆，并明确禁止默认串到别的项目", () => {
    const out = buildProjectMemoryPreamble("Cosmgrid", [
      {
        kind: "decision",
        title: "API Key 不进 SQLite",
        content: "保存在单独文件里，避免数据库明文混入",
        tags: "security,storage",
        importance: 92,
      },
    ]);
    expect(out).toContain("当前项目记忆");
    expect(out).toContain("项目：Cosmgrid");
    expect(out).toContain("不要把其他项目的经验混进来");
    expect(out).toContain("API Key 不进 SQLite");
    expect(out).toContain("重要度 92");
  });

  it("超长标题/内容会截断，避免把 system prompt 撑爆", () => {
    const out = buildProjectMemoryPreamble("P", [
      {
        kind: "context",
        title: "A".repeat(80),
        content: "B".repeat(220),
        tags: "tag1,tag2,tag3,tag4,tag5,tag6,tag7",
        importance: 70,
      },
    ]);
    expect(out).not.toContain("A".repeat(80));
    expect(out).not.toContain("B".repeat(220));
    expect(out).toContain("…");
  });
});

describe("buildCrossProjectMemoryPreamble", () => {
  it("无跨项目命中时返回 null", () => {
    expect(buildCrossProjectMemoryPreamble([])).toBeNull();
  });

  it("明确标注其他项目仅作借鉴，不代表当前项目事实", () => {
    const out = buildCrossProjectMemoryPreamble([
      {
        projectName: "Legacy App",
        kind: "lesson",
        title: "桌面端打包避开 Prisma",
        content: "打包时不要依赖运行时 Node 服务",
        importance: 88,
      },
    ]);
    expect(out).toContain("其他项目");
    expect(out).toContain("仅作借鉴");
    expect(out).toContain("Legacy App");
    expect(out).toContain("桌面端打包避开 Prisma");
  });
});
