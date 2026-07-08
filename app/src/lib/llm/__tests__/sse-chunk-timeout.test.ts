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

  it("服务端连响应头都不回（fetch() 本身悬挂）→ 也会超时报错，不是只护 chunk 间隔（修 GPT 5.5 卡死7分钟不动）", async () => {
    vi.useRealTimers();
    // base fetch 永不 resolve，模拟服务端挂起、连 headers 都没返回
    const base = vi.fn(() => new Promise<Response>(() => {}));
    const wrapped = withSseChunkTimeout(base as unknown as typeof fetch, 50);
    await expect(wrapped("https://x/hangs-before-headers")).rejects.toThrow(SSE_CHUNK_TIMEOUT_MARKER);
  });

  it("fetch() 正常在超时窗口内返回响应头 → 不受这道关卡影响，照常走 chunk 超时逻辑", async () => {
    vi.useRealTimers();
    const base = vi.fn(async () =>
      makeSseResponse([
        { delayMs: 5, data: "a" },
        { delayMs: 5, data: "b" },
      ]),
    );
    const wrapped = withSseChunkTimeout(base as unknown as typeof fetch, 50);
    const res = await wrapped("https://x/stream");
    await expect(drain(res)).resolves.toBe("ab");
  });

  it("连续多个 chunk 间隔超时 → 第一个超时即掐断，不再后续", async () => {
    vi.useRealTimers();
    const base = vi.fn(async () =>
      makeSseResponse([
        { delayMs: 5, data: "a" },
        { delayMs: 100, data: "b" }, // 第一个超时点
        { delayMs: 100, data: "c" }, // 不会再到（流已掐）
        { delayMs: 100, data: "d" },
      ]),
    );
    const wrapped = withSseChunkTimeout(base as unknown as typeof fetch, 50);
    const res = await wrapped("https://x/stream");
    await expect(drain(res)).rejects.toThrow(SSE_CHUNK_TIMEOUT_MARKER);
  });

  it("chunk 间隔刚好在阈值内（边界不触发）→ 正常透传", async () => {
    vi.useRealTimers();
    // 50ms 阈值，chunk 间隔 40ms（留 10ms 余量）→ 不应触发
    const base = vi.fn(async () =>
      makeSseResponse([
        { delayMs: 5, data: "a" },
        { delayMs: 40, data: "b" },
        { delayMs: 40, data: "c" },
      ]),
    );
    const wrapped = withSseChunkTimeout(base as unknown as typeof fetch, 50);
    const res = await wrapped("https://x/stream");
    await expect(drain(res)).resolves.toBe("abc");
  });

  it("per-chunk 计时独立：每个 chunk 来时计时器都重置，不会累加", async () => {
    vi.useRealTimers();
    // 5 个 chunk 每个间隔 30ms，单个不超 50ms 阈值；但如果计时累加就会在第 3 个时累计到 90ms 触发
    const base = vi.fn(async () =>
      makeSseResponse([
        { delayMs: 5, data: "a" },
        { delayMs: 30, data: "b" },
        { delayMs: 30, data: "c" },
        { delayMs: 30, data: "d" },
        { delayMs: 30, data: "e" },
      ]),
    );
    const wrapped = withSseChunkTimeout(base as unknown as typeof fetch, 50);
    const res = await wrapped("https://x/stream");
    await expect(drain(res)).resolves.toBe("abcde");
  });

  it("自定义短阈值（如 10ms）生效：长一点的 chunk 间隔即触发", async () => {
    vi.useRealTimers();
    const base = vi.fn(async () =>
      makeSseResponse([
        { delayMs: 5, data: "a" },
        { delayMs: 50, data: "b" }, // 超过 10ms 阈值
      ]),
    );
    const wrapped = withSseChunkTimeout(base as unknown as typeof fetch, 10);
    const res = await wrapped("https://x/stream");
    await expect(drain(res)).rejects.toThrow(SSE_CHUNK_TIMEOUT_MARKER);
  });
});
