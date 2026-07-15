import { describe, expect, it } from "vitest";
import zhCN from "../locales/zh-CN.json";
import enUS from "../locales/en-US.json";

// 治本回归测试（2026-07-15）：这个项目反复踩"新增组件用了 i18n key，但只补了一份 locale
// （通常是 zh-CN），另一份漏补"的坑——因为组件普遍用 t(key, "中文兜底") 兜底，漏补时
// 中文环境正常、英文环境显示中文，单元测试全绿也发现不了。
// 这里断言 zh-CN 和 en-US 的 leaf key 结构必须完全一致，任一侧漏 key 都会在这里失败，
// 且失败信息直接列出缺哪个 path。

function leafPaths(obj: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push(...leafPaths(value as Record<string, unknown>, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

describe("i18n locale parity", () => {
  it("zh-CN 与 en-US 的 key 结构完全一致（漏补任一 locale 都会在这里失败）", () => {
    const zh = new Set(leafPaths(zhCN as Record<string, unknown>));
    const en = new Set(leafPaths(enUS as Record<string, unknown>));
    const onlyInZh = [...zh].filter((path) => !en.has(path)).sort();
    const onlyInEn = [...en].filter((path) => !zh.has(path)).sort();
    expect({ onlyInZh, onlyInEn }).toEqual({ onlyInZh: [], onlyInEn: [] });
  });
});
