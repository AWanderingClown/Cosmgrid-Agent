import { describe, it, expect } from "vitest";
import { extractFilePaths, extractUrlClaims, extractQuotedClaims } from "../extract-claims";

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

// 真实事故（2026-07-07）：模型编了"我读到 GitHub 上 README/SKILL.md 说……"，实际是
// web_fetch 没拿到内容硬编的——之前的 extractFilePaths 会把 URL 整段删掉再抓路径，
// 这类"声称抓取过某网页"的谎完全不在覆盖范围里。补一条同思路的 URL claim 提取。
describe("extractUrlClaims（语境提取——只在读取/抓取动词后抓 URL）", () => {
  it("「读到了 URL」→ 抓 URL", () => {
    expect(extractUrlClaims("我读到了 https://github.com/foo/bar 的说明")).toContain(
      "https://github.com/foo/bar",
    );
  });

  it("「访问了 URL」「抓取了 URL」也算", () => {
    expect(extractUrlClaims("访问了 https://example.com/page")).toContain("https://example.com/page");
    expect(extractUrlClaims("抓取了 https://example.com/readme")).toContain("https://example.com/readme");
  });

  it("英文「I read/fetched URL」→ 抓 URL", () => {
    expect(extractUrlClaims("I read https://example.com/a")).toContain("https://example.com/a");
    expect(extractUrlClaims("I fetched https://example.com/b")).toContain("https://example.com/b");
  });

  it("正文提到 URL 但无读取动词 → 不抓（防误报，比如用户给的参考链接）", () => {
    expect(extractUrlClaims("仓库地址：https://github.com/foo/bar")).toEqual([]);
    expect(extractUrlClaims("参考 https://example.com/docs")).toEqual([]);
  });

  it("去掉尾部标点", () => {
    expect(extractUrlClaims("我读了 https://example.com/a。后续再说")).toContain("https://example.com/a");
  });

  it("去重", () => {
    const out = extractUrlClaims("我看了 https://example.com/a 又看了 https://example.com/a");
    expect(out).toEqual(["https://example.com/a"]);
  });

  it("无 URL 返回空数组", () => {
    expect(extractUrlClaims("我读取了 app/src/db.ts")).toEqual([]);
  });
});

// 真实事故（2026-07-07，系统性排查）：read/web_fetch 补完后，grep/bash/web_search 三个
// 工具的调用参数还是裸的——"我 grep 出来 X"/"我跑了 `pnpm test` 都过了"这类谎不管换哪个
// 模型都抓不到，这才是"换什么模型都会编"的真正原因。
describe("extractQuotedClaims（语境提取——只在运行/搜索动词后抓反引号/引号包住的字面值）", () => {
  it("「运行了 `X`」→ 抓 X", () => {
    expect(extractQuotedClaims("我运行了 `pnpm test`，都通过了")).toContain("pnpm test");
  });

  it("「跑了 'X'」「执行了 \"X\"」也算（引号不限反引号）", () => {
    expect(extractQuotedClaims("跑了 'ls -la'")).toContain("ls -la");
    expect(extractQuotedClaims('执行了 "grep -r foo"')).toContain("grep -r foo");
  });

  it("「搜索了/搜了 `X`」（grep pattern / web_search 查询词共用）", () => {
    expect(extractQuotedClaims("搜索了 `foo`，命中 3 处")).toContain("foo");
    expect(extractQuotedClaims("我搜了一下 `bar`")).toContain("bar");
  });

  it("英文「I ran/executed/searched `X`」→ 抓 X", () => {
    expect(extractQuotedClaims("I ran `pnpm build`")).toContain("pnpm build");
    expect(extractQuotedClaims("I searched `foo`")).toContain("foo");
  });

  it("没有引号包起来的裸词不抓（防误报——命令/pattern 没有天然可识别的字符形状）", () => {
    expect(extractQuotedClaims("我运行了测试都通过了")).toEqual([]);
    expect(extractQuotedClaims("跑了一下构建流程")).toEqual([]);
  });

  it("正文提到引号内容但无运行动词 → 不抓", () => {
    expect(extractQuotedClaims("配置项是 `foo`")).toEqual([]);
  });

  it("去重", () => {
    const out = extractQuotedClaims("运行了 `pnpm test` 又运行了 `pnpm test`");
    expect(out).toEqual(["pnpm test"]);
  });

  it("无匹配返回空数组", () => {
    expect(extractQuotedClaims("你好，今天天气不错")).toEqual([]);
  });
});
