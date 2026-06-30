export interface DesktopExportIntent {
  target: "desktop";
}

const SAVE_WORD_RE = /(保存|存到|导出|写到|生成|放到|save|export|write)/i;
const DESKTOP_WORD_RE = /(桌面|desktop)/i;

export function detectDesktopExportIntent(text: string): DesktopExportIntent | null {
  const normalized = text.trim();
  if (!normalized) return null;
  if (!SAVE_WORD_RE.test(normalized) || !DESKTOP_WORD_RE.test(normalized)) return null;
  return { target: "desktop" };
}

export function sanitizeExportFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#{}$!`']/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "cosmgrid-output";
}

export function buildMarkdownExportContent(args: {
  title: string;
  userRequest: string;
  content: string;
  createdAt: Date;
}): string {
  const date = args.createdAt.toISOString();
  return [
    `# ${args.title}`,
    "",
    `导出时间：${date}`,
    "",
    "用户请求：",
    "",
    `> ${args.userRequest.replace(/\n/g, "\n> ")}`,
    "",
    "---",
    "",
    args.content.trim(),
    "",
  ].join("\n");
}
