// skill 工具（2026-07-14 新增）——真 Skill 系统的调用入口。
//
// 渐进披露的第二步：workspacePreamble 里的 skill 目录（buildSkillCatalogPreamble）只给模型看
// name + description（便宜，常驻上下文）；模型判断任务与某个 skill 相关时调用本工具，把该
// skill 完整的 SKILL.md 正文拉进上下文（只有真正用到时才付出 token 成本）。
//
// 安全边界：security.kind = "none"——本工具只读磁盘上的 skill 定义文本，不碰用户工作区文件、
// 不执行命令，不受 K7 phase-capability 门控（那道门控管"这轮能不能写文件/跑命令"，与"能不能
// 查看一段指令文本"无关，读文本本身零副作用）。
//
// 已知限制（2026-07-14，明确不在本步骤范围）：skill 的 allowed-tools frontmatter 目前只被
// 解析、存储在 ClaudeCodeSkillDefinition 上，尚未接入 runSecurityPrecheck 对同一轮内的后续
// 工具调用做实际限制。原因：ToolContext 在 buildAiSdkTools 时对每个工具的 execute 闭包是
// 同一个对象引用，AI SDK 在一步内可能并行调用多个工具，若在这里运行时修改共享 ctx 会有竞态
// 风险，未经评审不做。现有 activeCaps（阶段能力）就是"每轮开始前算好、整轮不变"的粒度，
// allowed-tools 的强制生效计划对齐这个粒度（在下一轮开始时依据"上一轮是否调用过某 skill"
// 参与 ctx 组装），是后续步骤要做的事——不要误以为写了 allowed-tools 就已经被强制执行。

import { z } from "zod";
import type { ToolDefinition } from "./types";
import { successResult, errorResult, TOOL_NOT_FOUND, type ToolResultV2 } from "./result-contract";
import { loadClaudeCodeSkills } from "../claude-code-compat/skill-loader";

const paramsSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("要加载的 skill 名（.claude/skills/ 下的目录名，或其 SKILL.md frontmatter 里的 name 字段）"),
});

type SkillToolParams = z.infer<typeof paramsSchema>;

export const skillTool: ToolDefinition<SkillToolParams> = {
  name: "skill",
  description:
    "加载一个已安装 Skill（.claude/skills/<name>/SKILL.md）的完整指令。系统提示词里会列出当前项目" +
    "已安装 skill 的名称与简介；当任务与某个 skill 的描述相关时，调用本工具传入其 name，获取完整操作" +
    "指令后照做；与当前任务无关的 skill 不要调用。",
  parameters: paramsSchema,
  readOnly: true,
  security: { kind: "none" },
  async execute(input, ctx): Promise<ToolResultV2> {
    if (!ctx.workspacePath) {
      return errorResult({
        output: "当前没有绑定工作文件夹，无法读取 .claude/skills/。",
        summary: "skill 工具需要工作区",
        error: {
          code: TOOL_NOT_FOUND,
          rootCauseHint: "skill 工具依赖工作区路径定位 .claude/skills/ 目录，未绑定工作文件夹时无法使用。",
          retryable: false,
        },
      });
    }

    const skills = await loadClaudeCodeSkills(ctx.workspacePath);
    const found = skills.find((s) => s.name === input.name);
    if (!found) {
      const available = skills.map((s) => s.name).join("、") || "(当前项目没有安装任何 skill)";
      return errorResult({
        output: `未找到名为 "${input.name}" 的 skill。当前可用：${available}`,
        summary: `skill 未找到：${input.name}`,
        error: {
          code: TOOL_NOT_FOUND,
          rootCauseHint: "name 需与 .claude/skills/ 下的目录名或 SKILL.md frontmatter 的 name 字段一致。",
          retryable: true,
          retryInstruction: "换一个已列出的 skill 名重试，或直接不调用本工具继续任务。",
        },
      });
    }

    return successResult({
      output: [
        `# Skill: ${found.name}`,
        found.description ? `用途：${found.description}` : "",
        "",
        found.instructions,
      ]
        .filter(Boolean)
        .join("\n"),
      summary: `已加载 skill：${found.name}`,
    });
  },
};
