// v0.7 阶段4b — 命令安全分类（bash 工具的安全核心）
//
// 这是整个产品最危险的入口：AI 想跑命令。三道闸：
//   1. 危险模式黑名单（rm -rf / sudo / chmod 777 / 重定向覆盖 / curl|sh 等）→ 直接 block
//   2. 程序白名单（pnpm/npm/yarn/node/git/ls/cat 等只读或开发命令）→ allow（仍需用户确认）
//   3. 不在白名单 → block（默认拒绝，宁可少跑也不误伤）
//
// 纯函数、可红队测试。execute 时即便 allow 也强制走用户确认（双保险）。
//
// 2026-07-04 修复（技术债，坑.md 2.3）：逐段切分复合命令(; && || |)以前是裸正则
// split(/&&|\|\||;|\|/)，不理解引号——`git commit -m "a && b"` 这类合法命令里，引号内的
// "&&" 会被错误当成真操作符切开，导致误判（把 `b"` 当成一个新程序名，白名单查不到就
// 误 block）。改用 `shell-quote` 做真正的 token 化：字符串/操作符分开产出，引号内容原样
// 保留为一个 token，不会被内部的 shell 元字符污染分段结果。

import { parse as parseShellCommand } from "shell-quote";
import { BUILTIN_ALLOWED_PROGRAMS } from "@/lib/policy/command-allowlist";
import { DANGEROUS_COMMAND_PATTERNS } from "@/lib/security-invariants/dangerous-command-patterns";

export type CommandVerdict = "allow" | "block";

export interface CommandCheck {
  verdict: CommandVerdict;
  reason: string;
}

type ShellToken = string | { op: string; pattern?: string };

/**
 * 把命令串按真正的 shell 操作符（&& || ; |）切分成段，每段是 token 数组。
 * 用 shell-quote 解析，引号内容原样保留成一个 token，不会被内部的 && 等字符误判成分段点。
 * 重定向（> >> <）、子 shell（( )）等其他 operator 不当分段依据，也不当普通文本塞进段里——
 * 那些场景已经由上层的 $()／反引号／danger pattern 专项检查处理，这里只负责"这是几段、
 * 每段第一个程序是谁"。
 * 解析失败（极端畸形输入）时保守整条当一段，交给后面的白名单/黑名单兜底。
 */
function tokenizeSegments(cmd: string): string[][] {
  let tokens: ShellToken[];
  try {
    tokens = parseShellCommand(cmd) as ShellToken[];
  } catch {
    return [[cmd]];
  }
  const segments: string[][] = [];
  let current: string[] = [];
  for (const tok of tokens) {
    if (typeof tok === "string") {
      current.push(tok);
      continue;
    }
    if (tok.op === "&&" || tok.op === "||" || tok.op === ";" || tok.op === "|") {
      segments.push(current);
      current = [];
      continue;
    }
    if (tok.op === "glob" && typeof tok.pattern === "string") {
      current.push(tok.pattern);
      continue;
    }
    // 其余 operator（> >> < ( ) 等）：丢弃这个 token，不计入分段依据
  }
  segments.push(current);
  return segments.filter((seg) => seg.length > 0);
}

/** 一段 token 里去掉前导环境变量赋值（FOO=bar），取第一个真正的程序名 */
function firstProgramFromTokens(tokens: string[]): string {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  return tokens[i] ?? "";
}

/** 命令是否含真正的重定向操作符（> >>），不是引号内字符串里出现的 ">"。 */
function hasRedirectOperator(cmd: string): boolean {
  let tokens: ShellToken[];
  try {
    tokens = parseShellCommand(cmd) as ShellToken[];
  } catch {
    return />/.test(cmd); // 解析失败保守退回原始子串判断
  }
  return tokens.some((tok) => typeof tok !== "string" && (tok.op === ">" || tok.op === ">>"));
}

/** 取命令的第一个程序名（去掉前导环境变量赋值 FOO=bar cmd） */
export function firstProgram(command: string): string {
  const segments = tokenizeSegments(command.trim());
  return firstProgramFromTokens(segments[0] ?? []);
}

/**
 * 分类一条命令。block 优先于 allow。
 * 注意：含 shell 串联（; && || | ` $()）时，逐段都要过白名单，任一段不允许即 block。
 *
 * 引擎化改造方案阶段 1a：第三参数 `extraAllowed` 接 PolicyStore 已解析的允许程序集合。
 * 默认值仍是 builtin（BUILTIN_ALLOWED_PROGRAMS，含 pip3 等）；调用方按需用
 * `resolveAllowedPrograms(ctx.projectId)` 拿到 builtin ∪ 项目级 / 全局 override 后传入。
 *
 * 安全姿态不变：黑名单（DANGEROUS_PATTERNS / extraBlocked）优先级仍高于白名单。
 */
export function checkCommand(
  command: string,
  extraBlocked: string[] = [],
  extraAllowed: ReadonlySet<string> = BUILTIN_ALLOWED_PROGRAMS,
): CommandCheck {
  const cmd = command.trim();
  if (!cmd) return { verdict: "block", reason: "空命令" };

  // 自定义黑名单前缀（来自 WorkspaceConfig.blockedCommands）
  for (const b of extraBlocked) {
    if (b && cmd.toLowerCase().includes(b.toLowerCase())) {
      return { verdict: "block", reason: `命中项目黑名单：${b}` };
    }
  }

  // 危险模式
  for (const { re, reason } of DANGEROUS_COMMAND_PATTERNS) {
    if (re.test(cmd)) return { verdict: "block", reason: `危险命令：${reason}` };
  }

  // 命令替换 $() / 反引号 → 无法静态判断内部，保守 block
  if (/\$\(|`/.test(cmd)) {
    return { verdict: "block", reason: "含命令替换 $() / 反引号，无法静态审查" };
  }

  // 逐段（; && || |）检查白名单——用 shell-quote 真正 token 化，引号内的 && 等字符不会被误判成分段点
  const segments = tokenizeSegments(cmd);
  for (const seg of segments) {
    const prog = firstProgramFromTokens(seg);
    if (!extraAllowed.has(prog)) {
      return { verdict: "block", reason: `程序 "${prog || seg.join(" ")}" 不在白名单` };
    }
  }

  return { verdict: "allow", reason: "白名单命令" };
}

// 100% 只读的程序（只看不改，跑了不产生副作用）
const READONLY_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "find", "grep", "rg",
  // 只看不改的 shell 工具（cd 只切目录、其余纯输出）→ 免确认。
  // sed/awk/mkdir/touch/cp/mv/jq 能写文件，不在此列（仍走确认）。
  "cd", "which", "type", "date", "env", "printenv",
  "sort", "uniq", "cut", "tr", "column", "comm", "paste", "seq", "nl",
  "diff", "cmp", "file", "stat", "tree", "du", "basename", "dirname", "realpath", "readlink",
]);

// git 的只读子命令（其余 add/commit/checkout/reset/push/pull/merge/stash/clean 等都算写）
const GIT_READONLY_SUBCOMMANDS = new Set([
  "log", "status", "diff", "show", "branch", "remote", "ls-files", "rev-parse",
  "describe", "blame", "shortlog",
]);

/**
 * 命令是否「纯只读」——只看不改、跑了没副作用，可免用户确认。
 * 保守：含命令替换 $()/反引号一律当非只读；逐段都必须只读才算只读。
 * git 看子命令（log/status/diff 只读，commit/add/checkout 算写）。
 */
export function isReadOnlyCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  if (/\$\(|`/.test(cmd)) return false; // 命令替换无法静态判断 → 保守当非只读
  // 2026-07-04 修复：改用 token 化后的真操作符判断重定向，不再是裸 />/ 子串匹配——
  // 后者会把 `echo "a > b"` 这种引号内的 ">" 也误判成重定向，导致只读命令被错误要求确认。
  if (hasRedirectOperator(cmd)) return false;

  const segments = tokenizeSegments(cmd);
  if (segments.length === 0) return false;

  return segments.every((tokens) => {
    const stripped = tokens.slice();
    let i = 0;
    while (i < stripped.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(stripped[i]!)) i++;
    const rest = stripped.slice(i);
    const prog = rest[0] ?? "";
    if (READONLY_PROGRAMS.has(prog)) return true;
    if (prog === "git") {
      const sub = rest.slice(1).find((tk) => tk && !tk.startsWith("-"));
      return sub ? GIT_READONLY_SUBCOMMANDS.has(sub) : false;
    }
    return false;
  });
}
