/**
 * 引擎化改造方案 §5.3 / 阶段 3 R7：危险命令模式集中点。
 *
 * 原位置散在 src/lib/llm/tools/command-safety.ts:26-41。
 * 已通过 RESERVED_POLICY_KEYS['security.dangerous_patterns']（见
 * src/lib/security-invariants.ts）锁定，禁止 PolicyStore 运行时覆盖——黑名单
 * "可被覆盖 = 打开后门"，这个不对称正是方案 §4.2 的核心论据。
 *
 * 新增条目需要 PR 评审：test 断言 + harness eval 跑过 + 跨项目红蓝对抗。
 */

export interface DangerousCommandPattern {
  readonly re: RegExp;
  readonly reason: string;
}

/** frozen 数组——运行时禁止 push（即便 someone hack 进 JS 也无法扩展黑名单）。 */
export const DANGEROUS_COMMAND_PATTERNS: ReadonlyArray<DangerousCommandPattern> = Object.freeze([
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, reason: "rm -rf 递归强删" },
  { re: /\bsudo\b/i, reason: "sudo 提权" },
  { re: /\bchmod\s+777\b/, reason: "chmod 777 放开全部权限" },
  { re: /\bchown\b/i, reason: "chown 改属主" },
  { re: /\bmkfs\b|\bdd\s+if=/i, reason: "磁盘级危险操作" },
  { re: /:\(\)\s*\{.*\}\s*;/, reason: "fork 炸弹" },
  { re: />\s*\/dev\/sd|>\s*\/dev\/disk/i, reason: "写裸设备" },
  { re: /\bcurl\b[^|]*\|\s*(sh|bash|zsh)\b/i, reason: "curl 管道执行远程脚本" },
  { re: /\bwget\b[^|]*\|\s*(sh|bash|zsh)\b/i, reason: "wget 管道执行远程脚本" },
  // 2026-07-16：全 parity 档把 bash/sh/curl/wget 放进白名单后，任何"输出/下载管道给解释器执行"
  // 都是经典 RCE 向量（curl x | python、echo b64 | base64 -d | bash、git log | sh 等）。直接运行
  // 脚本（bash x.sh / python x.py，无管道）不受影响，仍放行。
  { re: /\|\s*(sh|bash|zsh|python3?|node|ruby|perl|php|deno|bun)\b/i, reason: "管道给解释器执行（潜在远程/动态代码执行）" },
  { re: /\beval\b/i, reason: "eval 动态执行" },
  { re: /\bshutdown\b|\breboot\b|\bhalt\b/i, reason: "关机/重启" },
  { re: /\bgit\s+push\b/i, reason: "git push 推远端（需人工，禁止自动）" },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/i, reason: "发布包到 registry" },
  { re: /\brm\s+-[a-z]*\s+\//, reason: "删除根级路径" },
]);
