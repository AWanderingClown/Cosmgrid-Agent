// 2026-07-14 —— 真 Skill：读用户的 .claude/skills/<name>/SKILL.md（Claude Code / Codex 同款格式）。
//
// 目录形态：`.claude/skills/<skill-name>/SKILL.md`（比 agents/commands 多一层目录——一个
// skill 允许带 scripts/references/assets 等同目录资源；本步骤只读 SKILL.md 正文，不处理
// 附带资源，后续要用再加）。
//
// 与 lib/skills/（DB 注册/审核那套）的关系：那套服务"应用内注册+审批"模型（用户/运营在 UI
// 里提交、走审核流程），本文件服务"用户自己在磁盘上放文件"模型（跟 CLAUDE.md 一样，本地文件
// 天然可信，不需要审批）——两者是不同产品形态，本文件不依赖 DB。唯一复用点：
// findBlockedPhrase 的内容治理规则（防"无需读取/凭经验/跳过检查"退化诱导词）是内容安全底线，
// 跟哪种注册模型无关，值得共用，而不是抄一份。

import { getFsAdapter } from "../tools/fs-adapter";
import { parseFrontmatter } from "./frontmatter";
import { findBlockedPhrase } from "@/lib/skills/capabilities";

export interface ClaudeCodeSkillDefinition {
  /** skill 名（frontmatter 的 name 字段优先，缺省用目录名） */
  name: string;
  description: string;
  /** SKILL.md 正文（frontmatter 之后的部分）；调用 skill 工具后注入模型上下文 */
  instructions: string;
  /** frontmatter 的 allowed-tools 字段（逗号分隔）解析出的原始工具名列表。
   *  未声明时为 undefined，语义 = "不限制"（与 Claude Code 一致：省略即全部工具可用）。
   *  注意（2026-07-14）：目前只被解析、存储，尚未接入执行器做同轮工具限制，见 tools/skill-tool.ts
   *  头部注释的说明。 */
  allowedTools?: string[];
  sourcePath: string;
}

/** 扫描 `${workspacePath}/.claude/skills/*\/SKILL.md`，解析成 skill 定义列表。
 *  正文命中内容黑名单词（K12，见 lib/skills/capabilities.ts）的 skill 直接跳过不加载——
 *  防止磁盘上的 SKILL.md 被用来注入"无需读取/跳过验证"这类瓦解 Harness 真实性保护的话术。
 *  目录不存在 / 单个 skill 解析失败都静默跳过（同 agent-loader/command-loader 的容错模式）。 */
export async function loadClaudeCodeSkills(workspacePath: string): Promise<ClaudeCodeSkillDefinition[]> {
  const fs = getFsAdapter();
  const skillsDir = `${workspacePath}/.claude/skills`;
  if (!(await fs.exists(skillsDir))) return [];

  let entries: Awaited<ReturnType<typeof fs.readDir>>;
  try {
    entries = await fs.readDir(skillsDir);
  } catch {
    return [];
  }

  const skills: ClaudeCodeSkillDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory || entry.name.startsWith(".")) continue;
    const skillMdPath = `${skillsDir}/${entry.name}/SKILL.md`;
    try {
      if (!(await fs.exists(skillMdPath))) continue;
      const raw = await fs.readTextFile(skillMdPath);
      const { data, body } = parseFrontmatter(raw);
      // 2026-07-14 修复：黑名单必须同时查 description/name，不能只查 body——
      // description 会被 buildSkillCatalogPreamble 无条件注入每轮 system prompt（不需要模型
      // 调用 skill 工具、不需要选中），只查 body 等于给"body 干净但 description 藏诱导词"的
      // SKILL.md 留了一条绕过内容治理防线的路。
      if (findBlockedPhrase([body, data.description ?? "", data.name ?? ""])) continue;

      const allowedTools = data["allowed-tools"]
        ? data["allowed-tools"].split(",").map((t) => t.trim()).filter(Boolean)
        : undefined;

      skills.push({
        name: data.name || entry.name,
        description: data.description ?? "",
        instructions: body,
        allowedTools,
        sourcePath: skillMdPath,
      });
    } catch {
      // 单个 skill 读取/解析失败跳过，不影响其余 skill
    }
  }
  return skills;
}

const CATALOG_MAX_CHARS = 2000;

/**
 * 把发现的 skill 渲染成一段"目录"文本，注入 system prompt。
 * 只含 name + description（渐进披露的"披露"部分，便宜、常驻上下文）；教模型看到匹配任务时
 * 调用 skill 工具传入 name 拉取完整指令（"渐进"部分，只在选中时才进上下文）。
 * 没有发现任何 skill 时返回 null（不占用 prompt 空间）。
 */
export function buildSkillCatalogPreamble(skills: ClaudeCodeSkillDefinition[]): string | null {
  if (skills.length === 0) return null;
  const lines = skills.map((s) => `- ${s.name}：${s.description || "(无描述)"}`);
  const body = lines.join("\n").slice(0, CATALOG_MAX_CHARS);
  return [
    "以下是本项目安装的 Skill（可复用能力包，来自 .claude/skills/）：",
    body,
    "当前任务与某个 skill 的描述相关时，调用 skill 工具（传入其 name）加载完整指令后再照做；" +
      "与当前任务无关的 skill 不要调用。",
  ].join("\n");
}
