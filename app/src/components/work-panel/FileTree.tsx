import { useEffect, useState } from "react";
import { exists, readDir } from "@tauri-apps/plugin-fs";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "target", ".next"]);

async function buildTree(root: string, depth = 0, maxDepth = 4): Promise<TreeNode[]> {
  if (depth > maxDepth || !(await exists(root))) return [];
  const entries = await readDir(root);
  const nodes: TreeNode[] = [];
  for (const entry of entries) {
    if (!entry.name || entry.name === ".DS_Store") continue;
    if (entry.isDirectory && (SKIP_DIRS.has(entry.name) || entry.name.startsWith("."))) continue;
    const path = `${root.replace(/\/+$/, "")}/${entry.name}`;
    const node: TreeNode = { name: entry.name, path, isDir: entry.isDirectory };
    if (entry.isDirectory) node.children = await buildTree(path, depth + 1, maxDepth);
    nodes.push(node);
  }
  return nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function FileTree({ rootPath, activePath, onOpenFile }: {
  rootPath: string;
  activePath?: string;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void buildTree(rootPath)
      .then((tree) => {
        if (!cancelled) setNodes(tree);
      })
      .catch(() => {
        if (!cancelled) setNodes([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  return (
    <div className="h-full overflow-auto custom-scrollbar text-xs" role="tree" aria-label={t("chat.workPanel.fileTree")}>
      {loading ? (
        <div className="p-3 text-[11px] text-muted-foreground/55">{t("chat.workPanel.loading")}</div>
      ) : nodes.length === 0 ? (
        <div className="p-3 text-[11px] text-muted-foreground/45">{t("chat.workPanel.noFiles")}</div>
      ) : (
        nodes.map((node) => (
          <TreeItem key={node.path} node={node} depth={0} activePath={activePath} onOpenFile={onOpenFile} />
        ))
      )}
    </div>
  );
}

function TreeItem({ node, depth, activePath, onOpenFile }: {
  node: TreeNode;
  depth: number;
  activePath?: string;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const active = activePath === node.path;
  const Icon = node.isDir ? (open ? FolderOpen : Folder) : File;

  if (node.isDir) {
    return (
      <div role="treeitem" aria-expanded={open} aria-level={depth + 1}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1 px-2 py-1 text-left text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
          style={{ paddingLeft: depth * 12 + 8 }}
        >
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <Icon className="w-3 h-3 shrink-0" />
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children?.map((child) => (
          <TreeItem key={child.path} node={child} depth={depth + 1} activePath={activePath} onOpenFile={onOpenFile} />
        ))}
      </div>
    );
  }

  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={active}
      aria-level={depth + 1}
      onClick={() => onOpenFile(node.path)}
      className={cn(
        "flex w-full items-center gap-1 px-2 py-1 text-left hover:bg-white/[0.04]",
        active ? "bg-primary/12 text-primary" : "text-muted-foreground hover:text-foreground",
      )}
      style={{ paddingLeft: depth * 12 + 24 }}
    >
      <Icon className="w-3 h-3 shrink-0" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}
