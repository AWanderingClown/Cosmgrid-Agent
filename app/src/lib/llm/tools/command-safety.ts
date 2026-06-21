// v0.7 阶段4b — 命令安全分类（bash 工具的安全核心）
//
// 这是整个产品最危险的入口：AI 想跑命令。三道闸：
//   1. 危险模式黑名单（rm -rf / sudo / chmod 777 / 重定向覆盖 / curl|sh 等）→ 直接 block
//   2. 程序白名单（pnpm/npm/yarn/node/git/ls/cat 等只读或开发命令）→ allow（仍需用户确认）
//   3. 不在白名单 → block（默认拒绝，宁可少跑也不误伤）
//
// 纯函数、可红队测试。execute 时即便 allow 也强制走用户确认（双保险）。

export type CommandVerdict = "allow" | "block";

export interface CommandCheck {
  verdict: CommandVerdict;
  reason: string;
}

// 危险模式（命中即 block，优先级最高）
const DANGEROUS_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, reason: "rm -rf 递归强删" },
  { re: /\bsudo\b/i, reason: "sudo 提权" },
  { re: /\bchmod\s+777\b/, reason: "chmod 777 放开全部权限" },
  { re: /\bchown\b/i, reason: "chown 改属主" },
  { re: /\bmkfs\b|\bdd\s+if=/i, reason: "磁盘级危险操作" },
  { re: /:\(\)\s*\{.*\}\s*;/, reason: "fork 炸弹" },
  { re: />\s*\/dev\/sd|>\s*\/dev\/disk/i, reason: "写裸设备" },
  { re: /\bcurl\b[^|]*\|\s*(sh|bash|zsh)\b/i, reason: "curl 管道执行远程脚本" },
  { re: /\bwget\b[^|]*\|\s*(sh|bash|zsh)\b/i, reason: "wget 管道执行远程脚本" },
  { re: /\beval\b/i, reason: "eval 动态执行" },
  { re: /\bshutdown\b|\breboot\b|\bhalt\b/i, reason: "关机/重启" },
  { re: /\bgit\s+push\b/i, reason: "git push 推远端（需人工，禁止自动）" },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/i, reason: "发布包到 registry" },
  { re: /\brm\s+-[a-z]*\s+\//, reason: "删除根级路径" },
];

// 允许的程序前缀（白名单；只允许开发常用 + 只读命令）
const ALLOWED_PROGRAMS = new Set([
  "pnpm", "npm", "yarn", "node", "npx",
  "git", "ls", "cat", "echo", "pwd", "head", "tail", "wc", "grep", "rg", "find",
  "tsc", "vitest", "jest", "eslint", "prettier", "python", "python3", "pip", "cargo", "go",
]);

/** 取命令的第一个程序名（去掉前导环境变量赋值 FOO=bar cmd） */
export function firstProgram(command: string): string {
  const tokens = command.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  return tokens[i] ?? "";
}

/**
 * 分类一条命令。block 优先于 allow。
 * 注意：含 shell 串联（; && || | ` $()）时，逐段都要过白名单，任一段不允许即 block。
 */
export function checkCommand(command: string, extraBlocked: string[] = []): CommandCheck {
  const cmd = command.trim();
  if (!cmd) return { verdict: "block", reason: "空命令" };

  // 自定义黑名单前缀（来自 WorkspaceConfig.blockedCommands）
  for (const b of extraBlocked) {
    if (b && cmd.toLowerCase().includes(b.toLowerCase())) {
      return { verdict: "block", reason: `命中项目黑名单：${b}` };
    }
  }

  // 危险模式
  for (const { re, reason } of DANGEROUS_PATTERNS) {
    if (re.test(cmd)) return { verdict: "block", reason: `危险命令：${reason}` };
  }

  // 命令替换 $() / 反引号 → 无法静态判断内部，保守 block
  if (/\$\(|`/.test(cmd)) {
    return { verdict: "block", reason: "含命令替换 $() / 反引号，无法静态审查" };
  }

  // 逐段（; && || |）检查白名单
  const segments = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
  for (const seg of segments) {
    const prog = firstProgram(seg);
    if (!ALLOWED_PROGRAMS.has(prog)) {
      return { verdict: "block", reason: `程序 "${prog || seg}" 不在白名单` };
    }
  }

  return { verdict: "allow", reason: "白名单命令" };
}
