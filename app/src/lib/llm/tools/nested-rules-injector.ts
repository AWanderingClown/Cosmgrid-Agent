// 2026-07-10 移植 OMO agents-md-core 思路 —— 嵌套 CLAUDE.md/AGENTS.md 逐级向上注入。
//
// 病根：workspace-context.ts 的开场小抄只读工作区**根级**的 CLAUDE.md/AGENTS.md，монorepo
// 场景下模型钻进 packages/xxx/ 干活时，那一层的约定完全没进上下文。
//
// 解法（对齐 OMO agents-md-core/injector.ts）：每次 read/edit 类工具成功命中一个文件，
// 从该文件所在目录往上走到工作区根（不含根——根已经被 workspace-context 的开场小抄覆盖），
// 把沿途每一层没注入过的 CLAUDE.md/AGENTS.md 追加到**这次工具调用自己的输出**里，让模型
// 跟着文件内容一起看到该目录的规则。按会话（conversationId）去重缓存，同一层只注入一次。

import { getFsAdapter } from "./fs-adapter";
import type { ToolContext } from "./types";

const NESTED_RULE_FILES = ["CLAUDE.md", "AGENTS.md"] as const;
const PER_FILE_MAX = 3000;
const TOTAL_MAX = 6000;
/** 安全上限：防止路径异常（如相对路径混入）导致目录链无限往上走 */
const MAX_WALK_LEVELS = 30;
/** 2026-07-10 修复：缓存本身不设上限的话，长期运行的进程里换的对话越多，
 *  这个 Map 就越大（虽然单条目很小，但没有 TTL/上限终究是个隐患）。
 *  按最多追踪 N 个会话做 FIFO 淘汰——Map 保留插入顺序，超限就丢最早那个。 */
export const MAX_TRACKED_CONVERSATIONS = 50;

/** 会话级已注入目录缓存：conversationId → 已经处理过的目录绝对路径集合。 */
const injectedDirsByConversation = new Map<string, Set<string>>();

function getOrCreateSeenDirs(cacheKey: string): Set<string> {
  const existing = injectedDirsByConversation.get(cacheKey);
  if (existing) return existing;

  if (injectedDirsByConversation.size >= MAX_TRACKED_CONVERSATIONS) {
    const oldestKey = injectedDirsByConversation.keys().next().value;
    if (oldestKey !== undefined) injectedDirsByConversation.delete(oldestKey);
  }
  const created = new Set<string>();
  injectedDirsByConversation.set(cacheKey, created);
  return created;
}

function parentDir(absPath: string): string | null {
  const trimmed = absPath.endsWith("/") ? absPath.slice(0, -1) : absPath;
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return null;
  return trimmed.slice(0, idx);
}

function dirname(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx <= 0 ? "/" : filePath.slice(0, idx);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…（内容过长已截断）` : text;
}

function normalizeDir(dir: string): string {
  return dir.endsWith("/") && dir.length > 1 ? dir.slice(0, -1) : dir;
}

/** 仅供测试：清空会话缓存，避免用例之间互相污染。 */
export function __resetNestedRulesCacheForTest(): void {
  injectedDirsByConversation.clear();
}

/**
 * 从 resolvedFilePath 所在目录往上走到 workspacePath（不含 workspacePath 本身），
 * 把沿途尚未注入过的 CLAUDE.md/AGENTS.md 拼成一段追加文本；没有新内容时返回空字符串。
 */
export async function collectNestedRulesContext(ctx: ToolContext, resolvedFilePath: string): Promise<string> {
  const workspaceRoot = normalizeDir(ctx.workspacePath);
  const cacheKey = ctx.conversationId ?? "__no_conversation__";
  const seen = getOrCreateSeenDirs(cacheKey);

  const fs = getFsAdapter();
  const sections: string[] = [];
  let budget = TOTAL_MAX;

  let dir = normalizeDir(dirname(resolvedFilePath));
  let levels = 0;

  while (dir && dir !== workspaceRoot && levels < MAX_WALK_LEVELS) {
    levels += 1;
    if (seen.has(dir)) {
      const next = parentDir(dir);
      if (!next) break;
      dir = normalizeDir(next);
      continue;
    }
    seen.add(dir);

    if (budget > 0) {
      for (const name of NESTED_RULE_FILES) {
        if (budget <= 0) break;
        const path = `${dir}/${name}`;
        try {
          if (!(await fs.exists(path))) continue;
          const raw = await fs.readTextFile(path);
          const content = truncate(raw.trim(), Math.min(PER_FILE_MAX, budget));
          if (!content) continue;
          sections.push(`# ${path}\n${content}`);
          budget -= content.length;
        } catch {
          // 单个文件读取失败（权限/编码等）跳过，不影响其余目录
        }
      }
    }

    const next = parentDir(dir);
    if (!next) break;
    dir = normalizeDir(next);
  }

  if (sections.length === 0) return "";
  return `\n\n以下是所在目录的补充规则文件（比工作区根目录更贴近这次改动）：\n\n${sections.join("\n\n")}`;
}
