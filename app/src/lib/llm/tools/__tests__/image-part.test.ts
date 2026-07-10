import { describe, expect, it } from "vitest";
import { bytesToDataUrl, inferImageMediaType, toImagePart, textPart } from "../image-part";

describe("inferImageMediaType", () => {
  it("png dataURL → image/png", () => {
    expect(inferImageMediaType("data:image/png;base64,AAA")).toBe("image/png");
  });

  it("jpeg dataURL → image/jpeg", () => {
    expect(inferImageMediaType("data:image/jpeg;base64,AAA")).toBe("image/jpeg");
  });

  it("jpg dataURL → image/jpeg（不是 image/jpg）", () => {
    expect(inferImageMediaType("data:image/jpg;base64,AAA")).toBe("image/jpeg");
  });

  it("webp / gif dataURL", () => {
    expect(inferImageMediaType("data:image/webp;base64,AAA")).toBe("image/webp");
    expect(inferImageMediaType("data:image/gif;base64,AAA")).toBe("image/gif");
  });

  it("非 dataURL 或非 image/ 前缀降级 image/png", () => {
    expect(inferImageMediaType("AAA")).toBe("image/png");
    expect(inferImageMediaType("data:application/json;base64,AAA")).toBe("image/png");
  });
});

describe("toImagePart", () => {
  it("mediaType 非空时直接用", () => {
    expect(toImagePart({ image: "data:image/png;base64,AAA", mediaType: "image/png" })).toEqual({
      type: "image",
      image: "data:image/png;base64,AAA",
      mediaType: "image/png",
    });
  });

  it("mediaType 缺失或 null 时按 dataURL 头推断", () => {
    expect(toImagePart({ image: "data:image/jpeg;base64,AAA" })).toMatchObject({ mediaType: "image/jpeg" });
    expect(toImagePart({ image: "data:image/webp;base64,AAA", mediaType: null })).toMatchObject({ mediaType: "image/webp" });
  });

  it("mediaType 是空字符串也走推断（不算有效）", () => {
    expect(toImagePart({ image: "data:image/gif;base64,AAA", mediaType: "" })).toMatchObject({ mediaType: "image/gif" });
  });
});

describe("textPart", () => {
  it("返回标准 TextPart 形状", () => {
    expect(textPart("hi")).toEqual({ type: "text", text: "hi" });
  });
});

describe("bytesToDataUrl", () => {
  it("PNG magic bytes 0x89 50 4E 47 → data:image/png;base64,iVBORw==", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(bytesToDataUrl(bytes, "image/png")).toBe("data:image/png;base64,iVBORw==");
  });

  it("空字节数组 → data:image/png;base64,", () => {
    expect(bytesToDataUrl(new Uint8Array(0), "image/png")).toBe("data:image/png;base64,");
  });
});