export interface FileTab {
  filePath: string;
  displayPath: string;
  content: string;
  language: string;
  source: "artifact" | "disk" | "error";
  isStreaming: boolean;
  streamedLines: number;
  totalLines: number;
  updatedAt: number;
  error?: string;
}

export function detectLanguage(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (/\.(tsx|ts)$/.test(lower)) return "typescript";
  if (/\.(jsx|js|mjs|cjs)$/.test(lower)) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".svg")) return "html";
  return "text";
}
