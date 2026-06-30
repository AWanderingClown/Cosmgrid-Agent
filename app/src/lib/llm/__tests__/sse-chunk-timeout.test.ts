import { describe, expect, it, vi } from "vitest";
import {
  SSE_CHUNK_TIMEOUT_MARKER,
  withSseChunkTimeout,
} from "../sse-chunk-timeout";

const encoder = new TextEncoder();

/** 造一个 text/event-stream Response，body 按给定的 (delayMs, payload) 序列吐 chunk。 */
function makeSseResponse(chunks: { delayMs: number; data: string }[]): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      for (const c of chunks) {
        await new Promise((r) => setTimeout(r, c.delayMs));
        ctrl.enqueue(encoder.encode(c.data));
      }
      ctrl.close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

describe("withSseChunkTimeout", () => {
  it("chunk 持续到达（间隔 < 超时）→ 不触发，完整透传", async () => {
    vi.useRealTimers();
    const base = vi.fn(async () =>
      makeSseResponse([
        { delayMs: 5, data: "a" },
        { delayMs: 5, data: "b" },
        { delayMs: 5, data: "c" },
      ]),
    );
    const wrapped = withSseChunkTimeout(base as unknown as typeof fetch, 50);
    const res = await wrapped("https://x/stream");
    await expect(drain(res)).resolves.toBe("abc");
  });

  it("某个 chunk 迟迟不来（间隔 > 超时）→ error 掉流并带 marker", async () => {
    vi.useRealTimers();
    const base = vi.fn(async () =>
      makeSseResponse([
        { delayMs: 5, data: "a" },
        { delayMs: 200, data: "b" }, // 超过 50ms 窗口 → 应被掐
      ]),
    );
    const wrapped = withSseChunkTimeout(base as unknown as typeof fetch, 50);
    const res = await wrapped("https://x/stream");
    await expect(drain(res)).rejects.toThrow(SSE_CHUNK_TIMEOUT_MARKER);
  });

  it("非 SSE 响应（普通 JSON）→ 原样返回，不包装", async () => {
    vi.useRealTimers();
    const json = new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    });
    const base = vi.fn(async () => json);
    const wrapped = withSseChunkTimeout(base as unknown as typeof fetch, 50);
    const res = await wrapped("https://x/json");
    await expect(res.text()).resolves.toBe('{"ok":true}');
  });
});
