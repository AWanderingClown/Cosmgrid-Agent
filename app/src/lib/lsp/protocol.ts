export interface EditorPosition {
  line: number;
  character: number;
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  source?: string;
  message: string;
}

export function filePathToUri(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `file://${normalized.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

export function uriToFilePath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  return decodeURIComponent(uri.slice("file://".length));
}

export function positionToLsp(position: EditorPosition): LspPosition {
  return {
    line: Math.max(0, position.line - 1),
    character: Math.max(0, position.character - 1),
  };
}

export function buildDidOpenParams(args: {
  path: string;
  languageId: string;
  content: string;
  version?: number;
}) {
  return {
    textDocument: {
      uri: filePathToUri(args.path),
      languageId: args.languageId,
      version: args.version ?? 1,
      text: args.content,
    },
  };
}

function severityLabel(severity: number | undefined): string {
  if (severity === 1) return "error";
  if (severity === 2) return "warning";
  if (severity === 3) return "info";
  if (severity === 4) return "hint";
  return "diagnostic";
}

export function formatLspDiagnostics(path: string, diagnostics: readonly LspDiagnostic[]): string {
  const shortPath = path.split("/").slice(-2).join("/");
  if (diagnostics.length === 0) return `✓ LSP diagnostics: ${shortPath} has no diagnostics.`;
  return [
    `LSP diagnostics for ${shortPath}:`,
    ...diagnostics.map((diagnostic) => {
      const line = diagnostic.range.start.line + 1;
      const character = diagnostic.range.start.character + 1;
      const source = diagnostic.source ? `${diagnostic.source} ` : "";
      return `- ${line}:${character} ${severityLabel(diagnostic.severity)} ${source}${diagnostic.message}`;
    }),
  ].join("\n");
}
