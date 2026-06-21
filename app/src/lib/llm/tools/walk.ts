// v0.7 阶段4 — 目录递归遍历 + 简单 glob 匹配（glob/grep 工具共用）

import { getFsAdapter } from "./fs-adapter";

/** 默认忽略的目录（不下钻，省时省内存） */
export const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "target", ".venv", "__pycache__",
]);

/** 把 glob 模式编译成 RegExp。支持 ** （跨目录）、* （单层任意）、? （单字符）。 */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*"; // ** 跨目录
        i++;
        if (pattern[i + 1] === "/") i++; // 吞掉 **/ 的斜杠
      } else {
        re += "[^/]*"; // * 单层
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * 递归收集 root 下的所有文件相对路径（POSIX 风格 /）。
 * 跳过 DEFAULT_IGNORE_DIRS；maxFiles 兜底防止超大目录卡死。
 */
export async function walkFiles(root: string, maxFiles = 5000): Promise<string[]> {
  const fs = getFsAdapter();
  const out: string[] = [];

  async function recurse(dir: string, rel: string): Promise<void> {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readDir(dir);
    } catch {
      return; // 读不了的目录跳过
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (DEFAULT_IGNORE_DIRS.has(e.name)) continue;
        await recurse(`${dir}/${e.name}`, childRel);
      } else if (e.isFile) {
        out.push(childRel);
      }
    }
  }

  await recurse(root, "");
  return out;
}
