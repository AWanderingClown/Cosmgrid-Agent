// 递归收集一个目录下所有 .md 文件——command-loader / agent-loader 共用，
// 避免各自重复实现一遍目录递归（对齐 OMO claude-code-command-loader 的 loadCommandsFromDir 思路，
// 但改用本项目已有的 FsAdapter 而不是 node:fs，好在测试里用内存假文件系统跑）。

import { getFsAdapter } from "../tools/fs-adapter";

export interface DiscoveredMarkdownFile {
  /** 绝对路径 */
  path: string;
  /** 相对扫描根目录的名字（不含 .md 后缀），子目录用 "/" 拼接，如 "git/commit" */
  name: string;
}

const MAX_DEPTH = 8;

export async function collectMarkdownFiles(dir: string, prefix = "", depth = 0): Promise<DiscoveredMarkdownFile[]> {
  if (depth > MAX_DEPTH) return [];
  const fs = getFsAdapter();

  let entries;
  try {
    entries = await fs.readDir(dir);
  } catch {
    return [];
  }

  const files: DiscoveredMarkdownFile[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    if (entry.isDirectory) {
      const subPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      const nested = await collectMarkdownFiles(`${dir}/${entry.name}`, subPrefix, depth + 1);
      files.push(...nested);
      continue;
    }

    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    const baseName = entry.name.slice(0, -3);
    const name = prefix ? `${prefix}/${baseName}` : baseName;
    files.push({ path: `${dir}/${entry.name}`, name });
  }
  return files;
}
