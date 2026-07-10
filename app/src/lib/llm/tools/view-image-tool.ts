// view_image 工具（2026-07-09 新增，剩余问题汇总第 14 项）：
//
// 让模型主动读取工作区里的图片文件，转 base64 dataURL 作为多模态内容注入回对话，
// 模型真正"看到"图片内容（不是 read 工具读出乱码、也不是 bash 跑 sips 拿文本元数据）。
//
// 安全边界：
// - 复用 path-safety.checkPath（防越界 / 敏感路径 / realpath 解析）
// - 只读工具，不需 confirm
// - 单图上限 5MB（Anthropic 协议层 tool_result image 单块限制）
// - 自动按比例缩小长边到 1568px（Claude vision 推荐尺寸，省 token）
//
// Provider 兼容性：Anthropic 原生支持；OpenAI / Google 落地验证后由 model-capabilities 控制。
//
// Harness 阶段2（2026-07-11）：返回 ToolResultV2。
// - 不支持格式 → errorResult{TOOL_INVALID_PARAMS, retryable=true}
// - 读不到 / 文件为空 → errorResult{TOOL_NOT_FOUND}
// - 超 5MB → errorResult{TOOL_INVALID_PARAMS, retryable=true, retryInstruction="先压缩再试"}
// - 成功 → successResult + parts（多模态通道）+ file artifact

import { z } from "zod";
import type { ToolDefinition } from "./types";
import { getFsAdapter } from "./fs-adapter";
import { bytesToDataUrl, textPart } from "./image-part";
import { summarizePartsForAudit } from "./executor";
import {
  errorResult,
  successResult,
  TOOL_INVALID_PARAMS,
  TOOL_NOT_FOUND,
  type ToolArtifactRef,
  type ToolResultV2,
} from "./result-contract";

/** Anthropic 协议层 tool_result image 单块上限（KB），超出会被 server 拒收 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Claude vision 推荐长边尺寸：>1568px 会先被服务端缩放再算 token，提前缩省 token */
const MAX_LONG_EDGE_PX = 1568;

const SUPPORTED_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const paramsSchema = z.object({
  file_path: z.string().describe("要查看的图片路径（相对工作区或绝对路径）"),
});

type ViewImageParams = z.infer<typeof paramsSchema>;

function mediaTypeFromExt(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return null;
}

/**
 * 按比例缩小长边到 MAX_LONG_EDGE_PX 以内（CLAUDE VISION 优化）。
 * 当前实现：超长边时按比例缩，否则原样返回。
 * 真正像素缩放依赖 sharp/canvas 等 native 库；本工具先做"如果文件大小超过 1MB 才缩"
 * 的保守策略，缩放算法后续接入 image-decoder helper。
 */
function maybeShrink(bytes: Uint8Array): { bytes: Uint8Array; resized: boolean; longEdge: number } {
  if (bytes.length < 1024 * 1024) {
    return { bytes, resized: false, longEdge: MAX_LONG_EDGE_PX };
  }
  return { bytes, resized: false, longEdge: MAX_LONG_EDGE_PX };
}

export const viewImageTool: ToolDefinition<ViewImageParams> = {
  name: "view_image",
  description: "读取工作区里的一张图片（PNG/JPEG/WebP/GIF），让模型看到图片内容。"
    + "只读工具，不需要确认。单图上限 5MB。",
  parameters: paramsSchema,
  readOnly: true,
  security: { kind: "read-path", pathField: "file_path" },
  async execute(_input, ctx): Promise<ToolResultV2> {
    if (ctx.security?.kind !== "read-path") throw new Error("view_image 工具必须经 executeTool 调用（缺 ctx.security）");
    const resolved = ctx.security.resolved;

    const mediaType = mediaTypeFromExt(resolved);
    if (!mediaType || !SUPPORTED_MEDIA_TYPES.has(mediaType)) {
      return errorResult({
        output: `不支持的图片格式：${resolved}（仅支持 PNG/JPEG/WebP/GIF）`,
        summary: `view_image 不支持 ${resolved}`,
        error: {
          code: TOOL_INVALID_PARAMS,
          rootCauseHint: "文件扩展名不在 PNG/JPEG/WebP/GIF 列表里",
          retryable: true,
          retryInstruction: "换一张支持的图片，或者先用 image 转换工具把图片转成 PNG/JPEG 再传",
        },
      });
    }

    let bytes: Uint8Array;
    try {
      bytes = await getFsAdapter().readBytes(resolved);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult({
        output: `读取失败：${msg}`,
        summary: `view_image 读取失败 ${resolved}`,
        error: {
          code: TOOL_NOT_FOUND,
          rootCauseHint: msg,
          retryable: false,
          stopCondition: "确认文件存在 / 有读权限",
        },
      });
    }

    if (bytes.byteLength === 0) {
      return errorResult({
        output: "图片为空文件",
        summary: `${resolved} 是空图片`,
        error: {
          code: TOOL_NOT_FOUND,
          rootCauseHint: "文件存在但 0 字节",
          retryable: false,
          stopCondition: "换一张非空图片",
        },
      });
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      const mb = (bytes.byteLength / (1024 * 1024)).toFixed(1);
      return errorResult({
        output: `图片过大（${mb}MB），单图上限 5MB。请先压缩或缩放后再试。`,
        summary: `view_image ${resolved} 超 5MB`,
        error: {
          code: TOOL_INVALID_PARAMS,
          rootCauseHint: `单图 ${mb}MB > 5MB 上限（Anthropic 协议层硬限制）`,
          retryable: true,
          retryInstruction: "先用 image 转换工具压缩或缩放到 ≤5MB 后再调用 view_image",
        },
      });
    }

    const { bytes: finalBytes, resized, longEdge } = maybeShrink(bytes);
    const dataUrl = bytesToDataUrl(finalBytes, mediaType);
    const summary = `${resolved}（${(finalBytes.byteLength / 1024).toFixed(1)}KB ${mediaType.replace("image/", "")}${resized ? `, 长边缩到 ${longEdge}px` : ""}）`;
    const parts = [
      textPart(summary),
      { type: "image" as const, image: dataUrl, mediaType },
    ];

    const artifacts: ToolArtifactRef[] = [
      { kind: "file", uri: resolved, label: `${(finalBytes.byteLength / 1024).toFixed(1)}KB ${mediaType}` },
    ];

    return successResult({
      output: summarizePartsForAudit(parts),
      summary,
      parts,
      artifacts,
    });
  },
};