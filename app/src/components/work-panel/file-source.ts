import { readTextFile } from "@tauri-apps/plugin-fs";

export function resolveWorkspaceFilePath(workspacePath: string | null | undefined, filePath: string): string {
  if (!filePath) return "";
  if (filePath.startsWith("/")) return filePath;
  if (!workspacePath) return filePath;
  return `${workspacePath.replace(/\/+$/, "")}/${filePath.replace(/^\/+/, "")}`;
}

export async function loadFileContent(args: {
  workspacePath?: string | null;
  filePath: string;
  artifactContent?: string;
  preferDisk?: boolean;
}): Promise<{ content: string; source: "artifact" | "disk" | "error"; error?: string }> {
  const resolved = resolveWorkspaceFilePath(args.workspacePath, args.filePath);
  if (!args.preferDisk && args.artifactContent !== undefined) {
    return { content: args.artifactContent, source: "artifact" };
  }

  try {
    return { content: await readTextFile(resolved), source: "disk" };
  } catch (err) {
    if (args.artifactContent !== undefined) {
      return { content: args.artifactContent, source: "artifact" };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `// 读取失败：${resolved}\n// ${message}`,
      source: "error",
      error: message,
    };
  }
}
