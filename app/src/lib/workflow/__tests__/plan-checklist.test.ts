import { describe, expect, it } from "vitest";
import { formatPlanChecklistStatus, parsePlanChecklist } from "../plan-checklist";

describe("parsePlanChecklist", () => {
  it("没有任何 checkbox → total 为 0", () => {
    expect(parsePlanChecklist("# 方案\n就是一段说明文字")).toEqual({
      total: 0,
      completed: 0,
      remaining: 0,
      nextTaskLabel: null,
    });
  });

  it("没有 TODOs/Final Verification 标题时，统计全文所有 checkbox（自由格式兜底）", () => {
    const md = ["# 方案", "- [x] 第一步", "- [ ] 第二步", "- [ ] 第三步"].join("\n");
    const result = parsePlanChecklist(md);
    expect(result.total).toBe(3);
    expect(result.completed).toBe(1);
    expect(result.remaining).toBe(2);
    expect(result.nextTaskLabel).toBe("第二步");
  });

  it("有 ## TODOs 标题时，只统计该 section 内的 checkbox", () => {
    const md = ["## 背景", "- [ ] 不应计入", "## TODOs", "- [x] 任务A", "- [ ] 任务B"].join("\n");
    const result = parsePlanChecklist(md);
    expect(result.total).toBe(2);
    expect(result.remaining).toBe(1);
    expect(result.nextTaskLabel).toBe("任务B");
  });

  it("全部完成时 remaining 为 0", () => {
    const md = ["## TODOs", "- [x] 任务A", "- [x] 任务B"].join("\n");
    expect(parsePlanChecklist(md).remaining).toBe(0);
  });
});

describe("formatPlanChecklistStatus", () => {
  it("total 为 0 时返回 null（不硬凑状态行）", () => {
    expect(formatPlanChecklistStatus({ total: 0, completed: 0, remaining: 0, nextTaskLabel: null })).toBeNull();
  });

  it("还有剩余任务时提示下一项 + 禁止提前宣称完成", () => {
    const status = formatPlanChecklistStatus({ total: 3, completed: 1, remaining: 2, nextTaskLabel: "写测试" });
    expect(status).toContain("1/3");
    expect(status).toContain("写测试");
    expect(status).toContain("不要向用户宣称任务已经完工");
  });

  it("全部完成时给出完成态提示", () => {
    const status = formatPlanChecklistStatus({ total: 2, completed: 2, remaining: 0, nextTaskLabel: null });
    expect(status).toContain("2/2 项已全部完成");
  });
});
