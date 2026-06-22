// diagnostics 单测（增强-1：写后自动类型检查）
import { describe, it, expect, vi } from "vitest";
import {
  toRelPath,
  parseTscErrors,
  formatDiagnostics,
  runDiagnostics,
  type DiagnosticsDeps,
} from "../diagnostics";

describe("toRelPath", () => {
  it("去掉工作区前缀", () => {
    expect(toRelPath("/ws", "/ws/src/foo.ts")).toBe("src/foo.ts");
    expect(toRelPath("/ws/", "/ws/src/foo.ts")).toBe("src/foo.ts");
  });
  it("不在工作区内则原样返回", () => {
    expect(toRelPath("/ws", "/other/foo.ts")).toBe("/other/foo.ts");
  });
});

describe("parseTscErrors — 只挑目标文件的错误", () => {
  const out = [
    "src/foo.ts(12,5): error TS2345: Argument of type 'string'...",
    "src/foo.ts(20,1): error TS1005: ';' expected.",
    "src/bar.ts(3,3): error TS2304: Cannot find name 'x'.",
    "随便一行无关日志",
  ].join("\n");

  it("过滤出目标文件的两条错误，忽略别的文件和噪音", () => {
    const errs = parseTscErrors(out, "src/foo.ts");
    expect(errs).toHaveLength(2);
    expect(errs[0]).toContain("TS2345");
  });

  it("relPath 为空返回空", () => {
    expect(parseTscErrors(out, "")).toEqual([]);
  });

  it("无匹配返回空", () => {
    expect(parseTscErrors(out, "src/baz.ts")).toEqual([]);
  });
});

describe("formatDiagnostics", () => {
  it("无错误 → 通过文案", () => {
    expect(formatDiagnostics("src/foo.ts", [])).toContain("无类型错误");
  });
  it("有错误 → 列出条数与明细", () => {
    const txt = formatDiagnostics("src/foo.ts", ["src/foo.ts(1,1): error TS1: x"]);
    expect(txt).toContain("1 处类型错误");
    expect(txt).toContain("TS1");
  });
});

function deps(over: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps {
  return {
    shell: { run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 }) },
    hasTsconfig: vi.fn().mockResolvedValue(true),
    ...over,
  };
}

describe("runDiagnostics — 适用性与结果", () => {
  it("非 TS 文件 → null（不跑 shell）", async () => {
    const d = deps();
    expect(await runDiagnostics("/ws", "/ws/readme.md", d)).toBeNull();
    expect(d.shell.run).not.toHaveBeenCalled();
  });

  it("无 tsconfig → null（不跑 shell）", async () => {
    const d = deps({ hasTsconfig: vi.fn().mockResolvedValue(false) });
    expect(await runDiagnostics("/ws", "/ws/src/a.ts", d)).toBeNull();
    expect(d.shell.run).not.toHaveBeenCalled();
  });

  it("TS 文件 + 有错 → 返回诊断文本", async () => {
    const d = deps({
      shell: { run: vi.fn().mockResolvedValue({ stdout: "src/a.ts(1,1): error TS2304: Cannot find name 'x'.", stderr: "", code: 1 }) },
    });
    const res = await runDiagnostics("/ws", "/ws/src/a.ts", d);
    expect(res).toContain("1 处类型错误");
    expect(res).toContain("TS2304");
  });

  it("TS 文件 + 无错 → 通过文案", async () => {
    const res = await runDiagnostics("/ws", "/ws/src/a.ts", deps());
    expect(res).toContain("无类型错误");
  });

  it("shell 抛错 → null（诊断失败不影响主流程）", async () => {
    const d = deps({ shell: { run: vi.fn().mockRejectedValue(new Error("no npx")) } });
    expect(await runDiagnostics("/ws", "/ws/src/a.ts", d)).toBeNull();
  });
});
