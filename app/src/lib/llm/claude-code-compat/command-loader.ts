// 2026-07-10 移植 OMO claude-code-compat-core 思路 —— 读用户已有的 .claude/commands。
//
// 目标用户：从 Claude Code 迁移过来的人，已经攒了一堆 slash 命令，不想为了换工具重配一遍。
// 只做"读文件 + frontmatter 解析"这一层（loader），不含"作为 slash 命令接入聊天输入框"的
// UI 集成——那需要命令菜单/参数占位符替换等产品设计决策，超出"读取已有资产"这一步的范围。

import { getFsAdapter } from "../tools/fs-adapter";
import { parseFrontmatter } from "./frontmatter";
import { collectMarkdownFiles } from "./markdown-walk";

export interface ClaudeCodeCommand {
  /** 命令名（相对 .claude/commands/ 的路径，不含扩展名，子目录用 "/" 拼接，如 "git/commit"） */
  name: string;
  description: string;
  /** 命令正文（frontmatter 之后的部分），$ARGUMENTS 占位符原样保留，由调用方决定怎么替换 */
  template: string;
  model?: string;
  argumentHint?: string;
  sourcePath: string;
}

/** 扫描 `${workspacePath}/.claude/commands/**\/*.md`，解析成命令列表。
 *  目录不存在 / 单个文件解析失败都静默跳过（读取已有资产是增值功能，不该因为脏文件报错）。 */
export async function loadClaudeCodeCommands(workspacePath: string): Promise<ClaudeCodeCommand[]> {
  const fs = getFsAdapter();
  const commandsDir = `${workspacePath}/.claude/commands`;
  if (!(await fs.exists(commandsDir))) return [];

  const files = await collectMarkdownFiles(commandsDir);
  const commands: ClaudeCodeCommand[] = [];
  for (const file of files) {
    try {
      const raw = await fs.readTextFile(file.path);
      const { data, body } = parseFrontmatter(raw);
      commands.push({
        name: file.name,
        description: data.description ?? "",
        template: body,
        model: data.model || undefined,
        argumentHint: data["argument-hint"] || undefined,
        sourcePath: file.path,
      });
    } catch {
      // 单个命令文件读取/解析失败跳过，不影响其余命令
    }
  }
  return commands;
}
