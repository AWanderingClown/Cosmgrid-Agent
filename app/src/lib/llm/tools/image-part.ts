// 多模态工具结果（view_image）用的 ImagePart / TextPart / ContentPart 类型 + 适配器。
//
// 设计动机：view_image 工具要让模型真的看到图片（不是 base64 字符串塞进 output 让模型自己解码）。
// Anthropic 协议层 tool_result 原生支持嵌 image content block，AI SDK 6 的
// @ai-sdk/anthropic provider 透传给该通道；OpenAI / Google 兼容性由 model-capabilities 控制。
//
// 与 attachments.ts 的 UserContentPart 区别：UserContentPart.mediaType 可选（手动上传场景
// 用户少填一个字段不致命）；工具结果走 AI SDK 必须有 mediaType，否则 provider 拒收。
// toImagePart 适配器把 UserContentPart 形态安全转成 ImagePart，缺 mediaType 时按 .dataUrl 头推断。

import type { ImagePart, TextPart } from "./types";

const DEFAULT_IMAGE_MEDIA_TYPE = "image/png";

export function inferImageMediaType(dataUrl: string): string {
  const match = /^data:image\/([a-z+]+);base64,/i.exec(dataUrl);
  if (!match) return DEFAULT_IMAGE_MEDIA_TYPE;
  const sub = match[1].toLowerCase();
  if (sub === "jpg" || sub === "jpeg") return "image/jpeg";
  if (sub === "svg+xml") return "image/svg+xml";
  return `image/${sub}`;
}

export function toImagePart(image: { image: string; mediaType?: string | null }): ImagePart {
  const mediaType = image.mediaType && image.mediaType.length > 0
    ? image.mediaType
    : inferImageMediaType(image.image);
  return { type: "image", image: image.image, mediaType };
}

export function textPart(text: string): TextPart {
  return { type: "text", text };
}

export function bytesToDataUrl(bytes: Uint8Array, mediaType: string): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const base64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  return `data:${mediaType};base64,${base64}`;
}