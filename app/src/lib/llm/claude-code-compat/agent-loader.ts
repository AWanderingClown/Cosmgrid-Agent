// 2026-07-10 移植 OMO claude-code-compat-core 思路 —— 读用户已有的 .claude/agents。
//
// 同 command-loader：只做"读文件 + frontmatter 解析"这一层，不含"接入本项目子代理调度"
// 的产品集成（本项目的模型/角色分派走自己的 orchestrator.ts + roles.ts，不是 subagent_type
// 这套 Claude Code 概念；要不要把读到的定义映射进本项目角色体系，是后续独立的产品决策）。

import { getFsAdapter } from "../tools/fs-adapter";
import { parseFrontmatter } from "./frontmatter";
import { collectMarkdownFiles } from "./markdown-walk";

export interface ClaudeCodeAgentDefinition {
  /** agent 名（frontmatter 的 name 字段优先，缺省用文件名） */
  name: string;
  description: string;
  /** system prompt 正文（frontmatter 之后的部分） */
  systemPrompt: string;
  model?: string;
  /** frontmatter 的 tools 字段（逗号分隔）解析成的工具名列表 */
  tools?: string[];
  sourcePath: string;
}

/** 扫描 `${workspacePath}/.claude/agents/**\/*.md`，解析成子代理定义列表。 */
export async function loadClaudeCodeAgents(workspacePath: string): Promise<ClaudeCodeAgentDefinition[]> {
  const fs = getFsAdapter();
  const agentsDir = `${workspacePath}/.claude/agents`;
  if (!(await fs.exists(agentsDir))) return [];

  const files = await collectMarkdownFiles(agentsDir);
  const agents: ClaudeCodeAgentDefinition[] = [];
  for (const file of files) {
    try {
      const raw = await fs.readTextFile(file.path);
      const { data, body } = parseFrontmatter(raw);
      const tools = data.tools
        ? data.tools.split(",").map((t) => t.trim()).filter(Boolean)
        : undefined;
      agents.push({
        name: data.name || file.name,
        description: data.description ?? "",
        systemPrompt: body,
        model: data.model || undefined,
        tools,
        sourcePath: file.path,
      });
    } catch {
      // 单个 agent 文件读取/解析失败跳过，不影响其余 agent
    }
  }
  return agents;
}
