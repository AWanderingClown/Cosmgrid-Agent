import { TauriRpcTransport } from "@/lib/rpc/tauri-transport";
import { JsonRpcClient } from "@/lib/rpc/rpc-client";
import { getFsAdapter } from "@/lib/llm/tools/fs-adapter";
import {
  buildDidOpenParams,
  filePathToUri,
  formatLspDiagnostics,
  type LspDiagnostic,
  positionToLsp,
} from "./protocol";
import { detectLspServer, languageIdForPath, type LspServerConfig } from "./server-detection";

type DiagnosticsMap = Map<string, LspDiagnostic[]>;

interface SessionEntry {
  client: JsonRpcClient;
  transport: TauriRpcTransport;
  diagnostics: DiagnosticsMap;
  openedUris: Set<string>;
  server: LspServerConfig;
}

interface LspLocation {
  uri?: string;
  targetUri?: string;
  range?: { start: { line: number; character: number } };
  targetSelectionRange?: { start: { line: number; character: number } };
}

interface LspHover {
  contents?: string | { kind?: string; value?: string } | Array<string | { value?: string }>;
}

const sessions = new Map<string, Promise<SessionEntry>>();

function sessionKey(workspacePath: string, server: LspServerConfig): string {
  return `${workspacePath}::${server.program}::${server.args.join(" ")}`;
}

function stableSessionId(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `lsp-${(hash >>> 0).toString(16)}`;
}

async function createSession(workspacePath: string, server: LspServerConfig): Promise<SessionEntry> {
  const transport = new TauriRpcTransport({
    sessionId: stableSessionId(sessionKey(workspacePath, server)),
    program: server.program,
    args: server.args,
    cwd: workspacePath,
    framing: "content-length",
  });
  const client = new JsonRpcClient(transport, { timeoutMs: 20_000 });
  const diagnostics: DiagnosticsMap = new Map();

  client.onNotification((method, params) => {
    if (method !== "textDocument/publishDiagnostics" || !params || typeof params !== "object") return;
    const payload = params as { uri?: unknown; diagnostics?: unknown };
    if (typeof payload.uri !== "string" || !Array.isArray(payload.diagnostics)) return;
    diagnostics.set(payload.uri, payload.diagnostics as LspDiagnostic[]);
  });

  await transport.start();
  await client.call("initialize", {
    processId: null,
    rootUri: filePathToUri(workspacePath),
    capabilities: {
      textDocument: {
        synchronization: { didOpen: true, didChange: false },
        hover: { contentFormat: ["markdown", "plaintext"] },
        definition: { linkSupport: true },
      },
    },
    workspaceFolders: [{ uri: filePathToUri(workspacePath), name: workspacePath.split("/").pop() ?? "workspace" }],
  });
  await client.notify("initialized", {});

  return { client, transport, diagnostics, openedUris: new Set(), server };
}

async function getSession(workspacePath: string, filePath: string): Promise<SessionEntry | null> {
  const server = await detectLspServer(workspacePath, filePath);
  if (!server) return null;
  const key = sessionKey(workspacePath, server);
  let promise = sessions.get(key);
  if (!promise) {
    promise = createSession(workspacePath, server).catch((error) => {
      sessions.delete(key);
      throw error;
    });
    sessions.set(key, promise);
  }
  return promise;
}

async function openFile(entry: SessionEntry, filePath: string): Promise<string> {
  const uri = filePathToUri(filePath);
  if (entry.openedUris.has(uri)) return uri;
  const languageId = languageIdForPath(filePath) ?? entry.server.languageId;
  const content = await getFsAdapter().readTextFile(filePath);
  await entry.client.notify("textDocument/didOpen", buildDidOpenParams({ path: filePath, languageId, content }));
  entry.openedUris.add(uri);
  return uri;
}

async function waitForDiagnostics(entry: SessionEntry, uri: string): Promise<LspDiagnostic[]> {
  const started = Date.now();
  while (Date.now() - started < 1_500) {
    const diagnostics = entry.diagnostics.get(uri);
    if (diagnostics) return diagnostics;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  return entry.diagnostics.get(uri) ?? [];
}

export async function getLspDiagnostics(workspacePath: string, filePath: string): Promise<string> {
  const entry = await getSession(workspacePath, filePath);
  if (!entry) {
    return "未找到可用的 TypeScript LSP。请在项目里安装 typescript-language-server，或把它加入 PATH。";
  }
  const uri = await openFile(entry, filePath);
  const diagnostics = await waitForDiagnostics(entry, uri);
  return formatLspDiagnostics(filePath, diagnostics);
}

function formatLocation(location: LspLocation): string | null {
  const uri = location.targetUri ?? location.uri;
  const start = location.targetSelectionRange?.start ?? location.range?.start;
  if (!uri || !start) return null;
  return `${uri}:${start.line + 1}:${start.character + 1}`;
}

export async function getLspDefinition(
  workspacePath: string,
  filePath: string,
  line: number,
  character: number,
): Promise<string> {
  const entry = await getSession(workspacePath, filePath);
  if (!entry) return "未找到可用的 TypeScript LSP，无法跳转定义。";
  const uri = await openFile(entry, filePath);
  const result = await entry.client.call("textDocument/definition", {
    textDocument: { uri },
    position: positionToLsp({ line, character }),
  });
  const locations = (Array.isArray(result) ? result : result ? [result] : []) as LspLocation[];
  const formatted = locations.map(formatLocation).filter((item): item is string => Boolean(item));
  return formatted.length > 0 ? `定义位置：\n${formatted.join("\n")}` : "没有找到定义位置。";
}

function hoverContentsToText(contents: LspHover["contents"]): string {
  if (!contents) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map((item) => typeof item === "string" ? item : item.value ?? "").filter(Boolean).join("\n\n");
  }
  return contents.value ?? "";
}

export async function getLspHover(
  workspacePath: string,
  filePath: string,
  line: number,
  character: number,
): Promise<string> {
  const entry = await getSession(workspacePath, filePath);
  if (!entry) return "未找到可用的 TypeScript LSP，无法查看悬停信息。";
  const uri = await openFile(entry, filePath);
  const result = await entry.client.call<LspHover | null>("textDocument/hover", {
    textDocument: { uri },
    position: positionToLsp({ line, character }),
  });
  const text = hoverContentsToText(result?.contents).trim();
  return text ? `Hover 信息：\n${text}` : "当前位置没有 Hover 信息。";
}

export async function disposeLspSessions(): Promise<void> {
  const entries = await Promise.allSettled([...sessions.values()]);
  sessions.clear();
  await Promise.all(entries.map((entry) => {
    if (entry.status !== "fulfilled") return Promise.resolve();
    entry.value.client.dispose();
    return entry.value.transport.dispose();
  }));
}
