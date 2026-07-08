import { invoke } from "@tauri-apps/api/core";
import { getFsAdapter } from "@/lib/llm/tools/fs-adapter";

export interface LspServerConfig {
  languageId: string;
  program: string;
  args: string[];
}

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export function languageIdForPath(path: string): string | null {
  const ext = extensionOf(path);
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return "typescript";
  if (ext === ".tsx") return "typescriptreact";
  if (ext === ".js") return "javascript";
  if (ext === ".jsx") return "javascriptreact";
  return null;
}

async function resolveProgram(program: string): Promise<string | null> {
  return invoke<string | null>("resolve_cli_program", { program }).catch(() => null);
}

export async function detectLspServer(workspacePath: string, filePath: string): Promise<LspServerConfig | null> {
  const languageId = languageIdForPath(filePath);
  if (!languageId || !TYPESCRIPT_EXTENSIONS.has(extensionOf(filePath))) return null;

  const fs = getFsAdapter();
  const localBinary = `${workspacePath}/node_modules/.bin/typescript-language-server`;
  if (await fs.exists(localBinary).catch(() => false)) {
    return { languageId, program: localBinary, args: ["--stdio"] };
  }

  const globalBinary = await resolveProgram("typescript-language-server");
  if (globalBinary) return { languageId, program: globalBinary, args: ["--stdio"] };

  return null;
}
