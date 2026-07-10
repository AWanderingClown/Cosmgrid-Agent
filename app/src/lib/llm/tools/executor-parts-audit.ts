import type { ContentPart } from "./types";

/**
 * 把 ContentPart[] 序列化成给人和审计看的摘要。
 * 图片只记录格式和大小，完整 base64 仍走多模态通道，不进 SQLite 审计库。
 */
export function summarizePartsForAudit(parts: readonly ContentPart[]): string {
  const summaries: string[] = [];
  let textBytes = 0;
  for (const part of parts) {
    if (part.type === "text") {
      textBytes += part.text.length;
      summaries.push(part.text);
    } else if (part.type === "image") {
      const mime = part.mediaType.replace("image/", "");
      const b64Len = part.image.startsWith("data:") ? part.image.split(",", 2)[1]?.length ?? 0 : part.image.length;
      const byteSize = Math.round((b64Len * 3) / 4);
      const kb = (byteSize / 1024).toFixed(1);
      summaries.push(`[image ${mime} ${kb}KB]`);
    }
  }
  if (textBytes > 0) summaries.unshift(`[text ${textBytes}B]`);
  return summaries.join(" | ");
}
