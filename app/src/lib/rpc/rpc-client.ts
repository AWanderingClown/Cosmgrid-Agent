export interface JsonRpcTransport {
  send(message: unknown): Promise<void>;
  onMessage(listener: (message: unknown) => void): void;
  onClose?(listener: () => void): void;
  onError?(listener: (error: Error) => void): void;
}

export interface JsonRpcClientOptions {
  timeoutMs?: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingCall>();
  private readonly timeoutMs: number;
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();
  private readonly requestHandlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();

  constructor(private readonly transport: JsonRpcTransport, options: JsonRpcClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.transport.onMessage((message) => this.handleMessage(message));
    this.transport.onClose?.(() => this.rejectPending(new Error("JSON-RPC transport closed")));
    this.transport.onError?.((error) => this.rejectPending(error));
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const request = params === undefined
      ? { jsonrpc: "2.0", id, method }
      : { jsonrpc: "2.0", id, method, params };

    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC call "${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
    });

    // 2026-07-15 review 修复：原实现在 `return promise` 之前 `await this.transport.send(request)`
    // ——如果 send()（对应 invoke("write_rpc_stdin")）本身悬挂不 resolve/reject（比如子进程
    // 不读 stdin 导致 Rust 侧写阻塞），这个 async 函数会永远停在这一行，永远走不到
    // `return promise`。上面那个 setTimeout 虽然仍会按时触发，但它 reject 的是这个局部变量
    // `promise`——调用方压根没拿到这个引用（因为函数还没 return），等于超时兜底完全落空，
    // 调用方看到的是永久挂起而不是一条清晰的超时错误。
    //
    // 改成不 await send()：立刻同步 return promise（调用方马上拿到这个会被 timeout 保护的
    // 引用），send() 本身异步跑；send() 失败时在 catch 里主动清理 pending 项并 reject，
    // send() 卡住不返回则完全交给上面已经在计时的 timeout 兜底。
    this.transport.send(request).catch((error: unknown) => {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    return promise;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const notification = params === undefined
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", method, params };
    await this.transport.send(notification);
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(method: string, handler: (params: unknown) => unknown | Promise<unknown>): () => void {
    this.requestHandlers.set(method, handler);
    return () => this.requestHandlers.delete(method);
  }

  private handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const maybeNotification = raw as { method?: unknown; params?: unknown; id?: unknown };
    if (!("id" in maybeNotification) && typeof maybeNotification.method === "string") {
      for (const listener of this.notificationListeners) listener(maybeNotification.method, maybeNotification.params);
      return;
    }
    if (typeof maybeNotification.method === "string" && maybeNotification.id !== undefined) {
      void this.handleServerRequest(maybeNotification.id as string | number, maybeNotification.method, maybeNotification.params);
      return;
    }
    if (!("id" in raw)) return;
    const message = raw as { id?: string | number; result?: unknown; error?: { message?: string; code?: number } };
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message ?? `JSON-RPC error ${message.error.code ?? ""}`.trim()));
      return;
    }
    pending.resolve(message.result);
  }

  private async handleServerRequest(id: string | number, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      await this.transport.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      return;
    }
    try {
      const result = await handler(params);
      await this.transport.send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      await this.transport.send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal error",
        },
      });
    }
  }

  dispose(): void {
    this.rejectPending(new Error("JSON-RPC client disposed"));
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
