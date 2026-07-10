/** 把 rawInput 转成稳定字符串，用于 doom-loop 比较和审计 input 字段。 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    try {
      return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    } catch {
      return String(value);
    }
  }
}

/** doom-loop 错误信息里的紧凑 input 展示，避免把大命令 / 大参数完整贴回模型。 */
export function shapeOfInput(raw: unknown): string {
  try {
    const json = JSON.stringify(raw);
    if (json.length <= 200) return json;
    return json.slice(0, 200) + "…(truncated)";
  } catch {
    return "(unserializable)";
  }
}
