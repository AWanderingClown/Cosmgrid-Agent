import { describe, it, expect } from "vitest";
import { detectPseudoToolCalls, hasPseudoToolCalls } from "../detect-pseudo-tools";

describe("detectPseudoToolCalls", () => {
  it("检测 XML 标签式伪工具调用（DB 实测格式）", () => {
    const text = '<run_command>{"command":"ls"}</run_command>';
    const out = detectPseudoToolCalls(text);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("tag");
    expect(out[0]?.toolName).toBe("run_command");
  });

  it("检测 view_file / update_plan 标签", () => {
    const text = "<view_file>{\"file_path\":\"/x\"}</view_file><update_plan>{\"plan\":\"...\"}</update_plan>";
    const out = detectPseudoToolCalls(text);
    expect(out.map((m) => m.toolName)).toEqual(["view_file", "update_plan"]);
  });

  it("检测裸 JSON 式伪工具调用", () => {
    const text = '{"name":"run_command","arguments":{"command":"pwd"}}';
    const out = detectPseudoToolCalls(text);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("json");
    expect(out[0]?.toolName).toBe("run_command");
  });

  it("正常对话文本不误报", () => {
    expect(detectPseudoToolCalls("我帮你看了一下这个文件，内容如下")).toEqual([]);
    expect(detectPseudoToolCalls("function foo() { return 1; }")).toEqual([]);
  });

  it("hasPseudoToolCalls 便捷方法", () => {
    expect(hasPseudoToolCalls("<run_command>x</run_command>")).toBe(true);
    expect(hasPseudoToolCalls("正常文本")).toBe(false);
  });
});
