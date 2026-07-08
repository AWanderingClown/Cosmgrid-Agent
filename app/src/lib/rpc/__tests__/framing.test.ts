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
});
