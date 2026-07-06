import { describe, it, expect } from "vitest";
import { extractFilePaths } from "../extract-claims";

describe("extractFilePaths（语境提取——只在读取动词后抓带扩展文件）", () => {
  it("「读取了 X」→ 抓 X", () => {
    expect(extractFilePaths("我读取了 /tmp/test.txt 这个文件")).toContain("/tmp/test.txt");
    expect(extractFilePaths("读取了 app/src/lib/db.ts")).toContain("app/src/lib/db.ts");
  });

  it("英文「I read X」→ 抓 X", () => {
    expect(extractFilePaths("I read app/src/db.ts")).toContain("app/src/db.ts");
  });

  it("正文提到路径但无读取动词 → 不抓（防误报）", () => {
    expect(extractFilePaths("源码找到了，在 /Users/x/Cosmgrid-Agent/ 下")).toEqual([]);
    expect(extractFilePaths("项目骨架：app/src/App.tsx 282 行")).toEqual([]);
    expect(extractFilePaths("git status 显示 pnpm-lock.yaml 改了")).toEqual([]);
  });

  it("单段无扩展路径片段不抓（/app /think 这种）", () => {
    expect(extractFilePaths("思考过程 /think /app /Cosmgrid-Agent")).toEqual([]);
  });

  it("URL 不抓", () => {
    expect(extractFilePaths("参考 https://example.com/foo/bar.ts")).toEqual([]);
  });

  it("无路径返回空数组", () => {
    expect(extractFilePaths("运行了 ls -la，输出正常")).toEqual([]);
  });

  it("去重", () => {
    const out = extractFilePaths("我读取了 /tmp/a.txt 又读取了 /tmp/a.txt");
    expect(out).toEqual(["/tmp/a.txt"]);
  });

  it("伪工具 JSON 里的路径不在 claim 抓（由 detect-pseudo-tools 管）", () => {
    expect(extractFilePaths('<run_command>{"command":"cat /Users/x/AGENTS.md"}</run_command>')).toEqual([]);
  });

  // 真实事故（2026-07-05）：模型说"反推自 agent-commerce.js 真实代码"编了一整套没读过的
  // 内容，之前完全没被抓到——两个漏洞都补了：
  it("「反推自 X」这类逆向分析用语也算声称读过（之前只认'读取了'）", () => {
    expect(extractFilePaths("OKX.AI 接单注册流程（反推自 agent-commerce.js 真实代码）")).toContain(
      "agent-commerce.js",
    );
  });

  it("bare 文件名（没有目录前缀）在读取动词后也要抓（之前要求至少一段目录/前缀）", () => {
    expect(extractFilePaths("我读取了 package.json 的内容")).toContain("package.json");
  });
});
