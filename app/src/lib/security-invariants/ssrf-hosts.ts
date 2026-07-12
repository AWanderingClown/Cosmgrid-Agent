/**
 * 引擎化改造方案 §5.3 / 阶段 3 R7：SSRF 防护 host 黑名单集中点。
 *
 * 原位置：src/lib/llm/tools/web-fetch-tool.ts:50
 * 安全底线，已通过 RESERVED_POLICY_KEYS['security.ssrf_hosts'] 锁定。
 */

export const SSRF_PRIVATE_HOSTNAMES: ReadonlySet<string> = Object.freeze(
  new Set(["localhost", "0.0.0.0"]),
);

/** 除 Set 内部项外的额外判断（host 末端 .local / ::1 等，代码层面硬编码不可配）。 */
export function isPrivateHost(host: string): boolean {
  if (SSRF_PRIVATE_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".local")) return true;
  if (host === "::1") return true;
  return false;
}
