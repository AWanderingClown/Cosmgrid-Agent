import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../frontmatter";

describe("parseFrontmatter", () => {
  it("解析扁平 key: value 字段 + 正文", () => {
    const content = ["---", "description: 提交代码", 'model: "claude-opus-4-8"', "---", "", "先跑 git status"].join("\n");
    const { data, body } = parseFrontmatter(content);
    expect(data.description).toBe("提交代码");
    expect(data.model).toBe("claude-opus-4-8");
    expect(body).toBe("先跑 git status");
  });

  it("没有 frontmatter 时 data 为空对象，body 为原文", () => {
    const { data, body } = parseFrontmatter("就是一段普通文字");
    expect(data).toEqual({});
    expect(body).toBe("就是一段普通文字");
  });

  it("单引号/双引号都能正确剥离", () => {
    const content = ["---", "name: 'my-agent'", "---", "body"].join("\n");
    expect(parseFrontmatter(content).data.name).toBe("my-agent");
  });

  it("忽略注释行和空行", () => {
    const content = ["---", "# 这是注释", "", "description: 测试", "---", "body"].join("\n");
    expect(parseFrontmatter(content).data.description).toBe("测试");
  });
});
