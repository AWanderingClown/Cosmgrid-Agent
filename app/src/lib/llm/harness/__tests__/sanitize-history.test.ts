import { describe, it, expect } from "vitest";
import {
  stripPseudoToolText,
  sanitizePseudoToolHistory,
  STRIPPED_PLACEHOLDER,
} from "../sanitize-history";

describe("stripPseudoToolText", () => {
  it("清掉真工具名 + <parameter> 的文本假标签（探针 D 复现的形态）", () => {
    const text =
      '好的，我来读取。\n<read_file>\n<parameter name="path">/Users/test/a.txt</parameter>\n</read_file>\n然后总结。';
    const out = stripPseudoToolText(text, ["read_file"]);
    expect(out).not.toContain("<read_file>");
    expect(out).not.toContain("<parameter");
    expect(out).toContain("好的，我来读取。");
    expect(out).toContain("然后总结。");
  });

  it("清掉记录里的多参数 <read> 假标签（真实事故形态）", () => {
    const text =
      '<read>\n<parameter name="file_path">项目文档/执行记录.md</parameter>\n<parameter name="offset">1980</parameter>\n<parameter name="limit">120</parameter>\n</read>';
    const out = stripPseudoToolText(text, ["read"]);
    expect(out.trim()).toBe("");
  });

  it("清掉 Claude antml <invoke name=…> + <parameter> 块", () => {
    const text =
      '我来查。<invoke name="read"><parameter name="file_path">x.md</parameter></invoke> 查完了。';
    const out = stripPseudoToolText(text);
    expect(out).not.toContain("<invoke");
    expect(out).not.toContain("<parameter");
    expect(out).toContain("我来查。");
    expect(out).toContain("查完了。");
  });

  it("清掉 <function_calls> 整块 wrapper", () => {
    const text =
      'prefix <function_calls><invoke name="grep"><parameter name="q">foo</parameter></invoke></function_calls> suffix';
    const out = stripPseudoToolText(text, ["grep"]);
    expect(out).not.toContain("function_calls");
    expect(out).not.toContain("invoke");
    expect(out).toContain("prefix");
    expect(out).toContain("suffix");
  });

  it("清掉死名单里的假工具名（run_command/view_file，无 parameter 子标签）", () => {
    const text = '开始。<run_command>{"command":"ls"}</run_command> 完成。';
    const out = stripPseudoToolText(text);
    expect(out).not.toContain("<run_command>");
    expect(out).toContain("开始。");
    expect(out).toContain("完成。");
  });

  it("清掉真工具名裸标签（<read>{json}</read>，无 parameter）", () => {
    const text = '<read>{"file_path":"a.md"}</read>';
    const out = stripPseudoToolText(text, ["read"]);
    expect(out.trim()).toBe("");
  });

  it("清掉裸 JSON 式 {\"name\":…,\"arguments\":…}", () => {
    const text = '调用：{"name":"read","arguments":{"path":"a.md"}} 好了';
    const out = stripPseudoToolText(text, ["read"]);
    expect(out).not.toContain('"arguments"');
    expect(out).toContain("好了");
  });

  it("清掉被停止键截断的残留开标签（<read> 无闭合）", () => {
    const text = '我来读一下。<read>\n<parameter name="file_path">a.md';
    const out = stripPseudoToolText(text, ["read"]);
    expect(out).not.toContain("<read>");
    expect(out).not.toContain("<parameter");
    expect(out).toContain("我来读一下。");
  });

  it("干净文本恒等返回（同一引用，零行为变化）", () => {
    const text = "这是一段正常回答，讲了 React 的 useEffect 用法，没有任何工具调用。";
    expect(stripPseudoToolText(text, ["read", "bash"])).toBe(text);
  });

  it("不误伤讲代码时的普通尖括号 / 泛型 / JSX", () => {
    const text = "用 `Array<string>` 声明，JSX 写 <div className='x'>hi</div> 就行。";
    const out = stripPseudoToolText(text, ["read"]);
    expect(out).toBe(text);
  });

  it("空串 / 无标签快速返回", () => {
    expect(stripPseudoToolText("", ["read"])).toBe("");
    expect(stripPseudoToolText("纯文字没有尖括号", ["read"])).toBe("纯文字没有尖括号");
  });
});

describe("sanitizePseudoToolHistory", () => {
  const pseudo =
    '<read_file>\n<parameter name="path">a.txt</parameter>\n</read_file>';

  it("只清 assistant，绝不动 user（用户可能合法粘贴 XML 讨论）", () => {
    const msgs = [
      { role: "system", content: "你是助手" },
      { role: "user", content: `帮我看看这个假标签 ${pseudo} 为什么没执行` },
      { role: "assistant", content: `我来读。${pseudo}` },
    ];
    const out = sanitizePseudoToolHistory(msgs, ["read_file"]);
    // user 原样保留
    expect(out[1].content).toContain("<read_file>");
    // assistant 被清洗
    expect(out[2].content).not.toContain("<read_file>");
    expect(out[2].content).toContain("我来读。");
  });

  it("assistant 被清空后用中性占位（不声称任何工具跑过）", () => {
    const msgs = [{ role: "assistant", content: pseudo }];
    const out = sanitizePseudoToolHistory(msgs, ["read_file"]);
    expect(out[0].content).toBe(STRIPPED_PLACEHOLDER);
  });

  it("全干净历史返回同一数组引用（零拷贝、零行为变化）", () => {
    const msgs = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好，有什么可以帮你？" },
    ];
    expect(sanitizePseudoToolHistory(msgs, ["read"])).toBe(msgs);
  });

  it("数组型 content 只清 text part，图片原样保留", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: `看图。${pseudo}` },
          { type: "image", image: "data:..." },
        ],
      },
    ];
    const out = sanitizePseudoToolHistory(msgs, ["read_file"]);
    const parts = out[0].content as Array<{ type: string; text?: string }>;
    expect(parts[0].text).not.toContain("<read_file>");
    expect(parts[0].text).toContain("看图。");
    expect(parts[1].type).toBe("image");
  });
});
