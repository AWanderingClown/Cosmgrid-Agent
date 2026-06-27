// 工作文件夹「项目自述」小抄——开场把工作目录里的 CLAUDE.md / AGENTS.md / README.md 读出来，
// 拼成一条 system 消息塞给模型。这就是用户说的"灵魂文件"：让 AI 一进项目就懂这是什么项目、
// 有哪些约定，而不是每次都要用户重讲。做法对齐 Claude Code（读 CLAUDE.md）/ OpenCode（读 AGENTS.md）。
//
// 只读、可注入（走 getFsAdapter），单测无需真实文件系统 / Tauri 运行时。

import { getFsAdapter } from "./tools/fs-adapter";

// 优先级从高到低：约定文件（CLAUDE.md/AGENTS.md）是"灵魂"，README 作补充说明。
const CONTEXT_FILES = ["CLAUDE.md", "AGENTS.md", "README.md"] as const;

// 单个文件最多读这么多字符，防超大 README 撑爆上下文 / 烧 token。
const PER_FILE_MAX = 4000;
// 所有自述文件合计上限。
const TOTAL_MAX = 8000;

/** 拼绝对路径，容忍 workspacePath 带或不带尾部斜杠。 */
function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…（内容过长已截断）` : text;
}

/**
 * 读工作目录下的项目自述文件，构造一条 system 小抄。
 * 没有任何自述文件时，仍返回一条只声明工作目录 + 工具可用的提示（让模型知道自己能动手）。
 * 读取失败的单个文件被安全跳过，不影响整体。
 *
 * @param workspacePath 工作文件夹绝对路径
 */
export async function buildWorkspacePreamble(workspacePath: string): Promise<string> {
  const fs = getFsAdapter();
  const sections: string[] = [];
  let budget = TOTAL_MAX;

  for (const name of CONTEXT_FILES) {
    if (budget <= 0) break;
    const path = joinPath(workspacePath, name);
    try {
      if (!(await fs.exists(path))) continue;
      const raw = await fs.readTextFile(path);
      const content = truncate(raw.trim(), Math.min(PER_FILE_MAX, budget));
      if (!content) continue;
      sections.push(`# ${name}\n${content}`);
      budget -= content.length;
    } catch {
      // 单个文件读取失败（权限/编码等）跳过，不影响其余文件与对话
    }
  }

  const header =
    `当前工作文件夹：${workspacePath}\n` +
    `你具备文件工具：可在此目录内读取文件、搜索、查看 git，也能写入文件、执行命令。\n` +
    `当用户要你创建/修改文件或运行命令时，**直接调用对应工具去做**——不要在回复里向用户索要确认，也不要只说"我来做/让我试试"然后停下。写入与执行的安全确认由应用自动弹窗处理，你无需在对话里征求同意。\n` +
    `回答涉及"这个项目/这些代码"的问题时，应先用工具读取真实文件，不要凭空猜测。`;

  if (sections.length === 0) {
    return header;
  }
  return `${header}\n\n以下是该项目的说明文件，请据此理解项目：\n\n${sections.join("\n\n")}`;
}
