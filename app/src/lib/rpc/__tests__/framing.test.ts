import { describe, expect, it } from "vitest";
import { decodeContentLengthFrames, decodeNewlineFrames, encodeContentLengthFrame, encodeNewlineFrame } from "../framing";

describe("rpc framing", () => {
  it("encodes and decodes LSP content-length frames", () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const frame = encodeContentLengthFrame(payload);

    expect(frame).toBe(`Content-Length: ${new TextEncoder().encode(payload).length}\r\n\r\n${payload}`);
    expect(decodeContentLengthFrames(frame)).toEqual({ messages: [payload], rest: "" });
  });

  it("keeps partial content-length frame bytes for the next chunk", () => {
    const one = encodeContentLengthFrame(JSON.stringify({ id: 1 }));
    const two = encodeContentLengthFrame(JSON.stringify({ id: 2 }));
    const cut = `${one}${two.slice(0, 10)}`;

    expect(decodeContentLengthFrames(cut)).toEqual({
      messages: [JSON.stringify({ id: 1 })],
      rest: two.slice(0, 10),
    });
  });

  it("encodes and decodes newline-delimited MCP stdio frames", () => {
    const a = JSON.stringify({ id: "a" });
    const b = JSON.stringify({ id: "b" });

    expect(encodeNewlineFrame(a)).toBe(`${a}\n`);
    expect(decodeNewlineFrames(`${a}\n${b}`)).toEqual({ messages: [a], rest: b });
  });

  // ── 补齐覆盖：以下覆盖 framing.ts 剩余分支（task #11）───────────────

  it("content-length：buffer 完全没有任何 \\r\\n\\r\\n → 整段留作 rest，不解出消息", () => {
    const buf = "Content-Length: 5";
    expect(decodeContentLengthFrames(buf)).toEqual({ messages: [], rest: buf });
  });

  it("content-length：header 存在但缺 Content-Length 字段 → break，整段留 rest", () => {
    const buf = "Content-Type: application/json\r\n\r\nhello";
    expect(decodeContentLengthFrames(buf)).toEqual({ messages: [], rest: buf });
  });

  it("content-length：声明字节数比实际 body 多 → 不够读，break 留 rest", () => {
    // 头声明 100 字节但 body 只有 5 字符
    const buf = "Content-Length: 100\r\n\r\nhello";
    expect(decodeContentLengthFrames(buf)).toEqual({ messages: [], rest: buf });
  });

  it("content-length：解出多帧（两帧相邻） → messages[2]、rest 留尾巴", () => {
    const a = JSON.stringify({ id: 1 });
    const b = JSON.stringify({ id: 2 });
    const buf = `${encodeContentLengthFrame(a)}${encodeContentLengthFrame(b)}`;
    expect(decodeContentLengthFrames(buf)).toEqual({ messages: [a, b], rest: "" });
  });

  it("newline framing：尾部只有不完整一行（无 \\n） → 整段留 rest", () => {
    const buf = `{ "id":"a"}\n{ "id":"b"`;
    expect(decodeNewlineFrames(buf)).toEqual({ messages: [`{ "id":"a"}`], rest: `{ "id":"b"` });
  });

  it("newline framing：空行 / 空白行被过滤掉，不当成消息", () => {
    const buf = `{ "id":"a"}\n\n   \n{ "id":"b"}\n`;
    expect(decodeNewlineFrames(buf)).toEqual({ messages: [`{ "id":"a"}`, `{ "id":"b"}`], rest: "" });
  });

  it("encodeNewlineFrame：payload 末尾自带换行会被剥掉再加一个 \\n，避免出现双 \\n", () => {
    expect(encodeNewlineFrame("hello\n")).toBe("hello\n");
    expect(encodeNewlineFrame("hello\n\n\n")).toBe("hello\n");
  });
});
