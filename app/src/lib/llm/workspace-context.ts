// 工作文件夹「项目自述」小抄——开场把工作目录里的 CLAUDE.md / AGENTS.md / README.md 读出来，
// 拼成一条 system 消息塞给模型。这就是用户说的"灵魂文件"：让 AI 一进项目就懂这是什么项目、
// 有哪些约定，而不是每次都要用户重讲。做法对齐 Claude Code（读 CLAUDE.md）/ OpenCode（读 AGENTS.md）。
//
// 只读、可注入（走 getFsAdapter），单测无需真实文件系统 / Tauri 运行时。

import { getFsAdapter } from "./tools/fs-adapter";
import { listShallowTree } from "./tools/walk";

// 优先级从高到低：约定文件（CLAUDE.md/AGENTS.md）是"灵魂"，README 作补充说明。
const CONTEXT_FILES = ["CLAUDE.md", "AGENTS.md", "README.md"] as const;

// 单个文件最多读这么多字符，防超大 README 撑爆上下文 / 烧 token。
const PER_FILE_MAX = 4000;
// 所有自述文件合计上限。
const TOTAL_MAX = 8000;
// 浅层目录树文本上限——只是给模型一张"地图"，不需要很长。
const TREE_MAX_CHARS = 2000;

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
export async function buildWorkspacePreamble(
  workspacePath: string,
  options: { includeWrite?: boolean; desktopPath?: string | null } = {},
): Promise<string> {
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

  const toolLine = options.includeWrite
    ? "你具备文件工具：可在此目录内读取文件、搜索、查看 git，也能写入文件、执行命令。"
    : "你具备只读文件工具：可在此目录内读取文件、搜索、查看 git；本轮没有写入文件或执行命令的工具。";
  const actionLine = options.includeWrite
    ? "当用户要你创建/修改文件或运行命令时，**直接调用对应工具去做**——不要在回复里向用户索要确认，也不要只说\"我来做/让我试试\"然后停下。写入与执行的安全确认由应用自动弹窗处理，你无需在对话里征求同意。"
    : "本轮如果只是理解项目、分析代码、写文案或总结，请使用 read/glob/grep/git_read 等只读工具完成；不要声称需要 bash，也不要假装执行命令。";
  // 桌面路径事实——只有具备写工具时才有意义（只读模式下说了也用不上）。
  // 有这句，"保存/导出到桌面"这类需求模型自己用 write 工具就能办，不需要任何应用层的隐藏特例：
  // write 工具本身允许写到工作区之外，只是会多弹一次"工作区之外"的confirm，用户批准即可。
  const desktopLine =
    options.includeWrite && options.desktopPath
      ? `\n如果用户要求把内容保存/导出到桌面，桌面的绝对路径是：${options.desktopPath}——直接用 write 工具写这个路径下的文件即可，会有一次"写到工作区之外"的确认，用户同意后才会真正写入，你不需要，也不应该自己声称"已保存"而不实际调用工具。`
      : "";
  const header =
    `当前工作文件夹：${workspacePath}\n` +
    `${toolLine}\n` +
    `${actionLine}${desktopLine}\n` +
    `回答涉及"这个项目/这些代码"的问题时，应先用工具读取真实文件，不要凭空猜测。\n` +
    `探索项目结构时，一轮内可以同时发起多个互不依赖的工具调用（如同时 glob 多个模式、同时 read 多个文件），` +
    `不要每轮只查一件事再等下一轮——那样会把本该几轮完成的探索拖成十几二十轮。`;

  // 浅层目录树——给模型一张开场"地图"，别让它靠瞎猜 glob 模式去摸根目录下有什么，
  // 猜不中容易误判"没有源码"（实测 MiniMax-M3 在没有这张地图时真的下过这种错误结论）。
  let treeSection = "";
  try {
    const entries = await listShallowTree(workspacePath);
    if (entries.length > 0) {
      treeSection =
        `\n\n以下是工作目录的浅层结构（已按 .gitignore 过滤，只展开前两层）：\n` +
        truncate(entries.join("\n"), TREE_MAX_CHARS);
    }
  } catch {
    // 列不出目录树不影响其余小抄内容
  }

  if (sections.length === 0) {
    return `${header}${treeSection}`;
  }
  return `${header}${treeSection}\n\n以下是该项目的说明文件，请据此理解项目：\n\n${sections.join("\n\n")}`;
}
