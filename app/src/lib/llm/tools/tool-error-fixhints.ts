// 2026-07-10 移植 OMO delegate-core/retry-patterns 的思路 —— 工具调用参数错误自纠。
//
// 病根：zod 校验失败时原样把 ZodError.message 甩给模型，那是一段 JSON 数组文本
// （如 `[{"code":"invalid_type","path":["file_path"],...}]`），模型要么读不懂、要么
// 瞎猜着重试，反复试错浪费好几轮。
//
// 解法：不像 OMO 那样维护一张"已知错误字符串 → fixHint"的静态表（那是因为它的错误来自
// 子进程 [ERROR] 文本，没有结构化信息）——我们的错误本来就是结构化的 zod issues，可以
// 对每一条 issue 直接生成"哪个字段、缺什么、该填什么"的可执行提示，覆盖面比硬编码表更广，
// 且自动适配所有工具的 schema，不需要每加一个新工具就补一条模式。

import { z } from "zod";

function formatPath(path: readonly (string | number | symbol)[]): string {
  if (path.length === 0) return "(根参数)";
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") {
      out += `[${seg}]`;
    } else {
      out += out ? `.${String(seg)}` : String(seg);
    }
  }
  return out;
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const field = formatPath(issue.path);
  switch (issue.code) {
    case "invalid_type": {
      const i = issue as z.core.$ZodIssueInvalidType;
      return `字段 "${field}" 类型不对：应为 ${i.expected}。`;
    }
    case "too_small": {
      const i = issue as z.core.$ZodIssueTooSmall;
      const unit = i.origin === "array" ? "个元素" : i.origin === "string" ? "个字符" : "";
      return `字段 "${field}" 太小：至少需要 ${String(i.minimum)}${unit}（当前不满足）。`;
    }
    case "too_big": {
      const i = issue as z.core.$ZodIssueTooBig;
      const unit = i.origin === "array" ? "个元素" : i.origin === "string" ? "个字符" : "";
      return `字段 "${field}" 太大：最多允许 ${String(i.maximum)}${unit}。`;
    }
    case "invalid_value": {
      const i = issue as z.core.$ZodIssueInvalidValue;
      const options = i.values.map((v) => JSON.stringify(v)).join(" | ");
      return `字段 "${field}" 的值不合法：只能是 ${options} 之一。`;
    }
    case "unrecognized_keys": {
      const i = issue as z.core.$ZodIssueUnrecognizedKeys;
      return `多传了不认识的字段：${i.keys.join(", ")}（请去掉）。`;
    }
    case "invalid_union":
      return `字段 "${field}" 不满足任何一种允许的格式。`;
    default:
      return `字段 "${field}"：${issue.message}`;
  }
}

/**
 * 把工具参数的 ZodError 转成给模型看的可执行修复提示（每个问题一行）。
 * 非 ZodError 原样返回 error.message（业务逻辑抛的错误已经是给人看的清晰文案）。
 */
export function formatToolParamsError(toolName: string, error: unknown): string {
  if (!(error instanceof z.ZodError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const lines = error.issues.map((issue) => `- ${formatIssue(issue)}`);
  return `工具 "${toolName}" 的参数不对（共 ${error.issues.length} 处），请修正后重新调用：\n${lines.join("\n")}`;
}
