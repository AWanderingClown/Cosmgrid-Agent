// SSE chunk 静默超时（移植自 OpenCode 的 wrapSSE，技术参考/opencode-dev/.../provider/provider.ts）
//
// 解决的真 bug：某些 provider（实测 MiniMax）把活干完后**不发结束信号 / [DONE]**，
// HTTP/SSE 连接挂着既不结束也不报错 → streamText 的 `for await` 永不退出 →
// 上层 finally 不执行 → isStreaming 永远卡 true → 界面「回复中」卡死、停止键也救不回。
//
// 为什么不是「静默超时一刀切」会误杀长任务：
// - 这是 **per-chunk** 计时：每收到一个 SSE chunk（token / 思考 / 工具调用增量）就重置。
//   模型在真干活时 chunk 一直在流 → 永不触发。
// - 多步工具循环里「本地执行工具」那段不在这个 HTTP 流内，下一步是全新请求、全新计时。
// - 只有当 provider 连接**真正死寂**（没有任何 chunk 持续 ms 毫秒）才触发——正是僵尸流。
//
// 触发后：error 掉响应体流 → streamText 抛错 → chat-fallback 归类为可恢复超时 →
// 自动切下一个模型 / 优雅收尾，并把 isStreaming 关掉。

/** 触发标记：chat-fallback / error-classifier 据此把它归到「可恢复超时」而非「用户主动停止」。 */
export const SSE_CHUNK_TIMEOUT_MARKER = "SSE_CHUNK_TIMEOUT";

/** 默认 chunk 静默上限。健康的流每几百毫秒就有 chunk，60s 不会误伤；僵尸流 60s 内必被掐。 */
export const SSE_CHUNK_TIMEOUT_MS = 60_000;

/**
 * 把一个 SSE 响应体包一层：每次读下一个 chunk 时和 `setTimeout(ms)` 赛跑。
 * - 来了 chunk → 清计时器、透传、继续（计时重置）。
 * - ms 内一个 chunk 都没来 → error 掉下游流（streamText 会抛错）。
 * 非 text/event-stream 响应原样返回（不影响非流式请求）。
 */
function wrapSseResponse(res: Response, ms: number): Response {
  if (typeof ms !== "number" || ms <= 0) return res;
  if (!res.body) return res;
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res;

  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const part = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `${SSE_CHUNK_TIMEOUT_MARKER}: 模型流式响应中断（超过 ${ms}ms 没有任何数据）。` +
                  `可能是该模型把任务做完后没有正常结束连接。`,
              ),
            );
          }, ms);
          reader.read().then(resolve, reject);
        });
        if (timer) clearTimeout(timer);

        if (part.done) {
          ctrl.close();
          return;
        }
        ctrl.enqueue(part.value);
      } catch (err) {
        if (timer) clearTimeout(timer);
        // 掐掉底层读取，避免悬挂的 socket 泄漏
        void reader.cancel(err).catch(() => {});
        ctrl.error(err);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  });
}

/**
 * 给 fetch() 本身（拿到第一个 Response 之前）套超时——防的是「连响应头都没返回」的僵死：
 * 服务端一直不回应（挂起 / 网络卡死），`fetch()` 这个 Promise 永远不 resolve/reject。
 * 这跟 wrapSseResponse 是两道独立的关卡：那道防"流开始后中途哑了"，这道防"流压根没开始"——
 * 实测 GPT 5.5 这类重 reasoning 模型会在服务端"思考"很久才吐第一个字节，
 * 只护 chunk 间隔护不住这种情况，得连 fetch() 本身也一起计时。
 */
async function fetchWithTimeout(
  baseFetch: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  ms: number,
): Promise<Response> {
  if (typeof ms !== "number" || ms <= 0) return baseFetch(input as RequestInfo, init);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Response>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `${SSE_CHUNK_TIMEOUT_MARKER}: 请求发出后 ${ms}ms 内服务端没有任何响应（可能是服务端挂起或网络卡死）。`,
          ),
        );
      }, ms);
      baseFetch(input as RequestInfo, init).then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 把任意 fetch 包成「带 SSE chunk 静默超时」的 fetch，注入给 Vercel AI SDK 的 provider。
 * @param baseFetch 底层 fetch（不传则用全局 fetch）
 * @param ms chunk 静默上限，默认 {@link SSE_CHUNK_TIMEOUT_MS}
 */
export function withSseChunkTimeout(
  baseFetch: typeof fetch = fetch,
  ms: number = SSE_CHUNK_TIMEOUT_MS,
): typeof fetch {
  return async (input, init) => {
    const res = await fetchWithTimeout(baseFetch, input, init, ms);
    return wrapSseResponse(res, ms);
  };
}
