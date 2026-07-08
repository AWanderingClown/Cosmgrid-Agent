export interface JsonRpcTransport {
  send(message: unknown): Promise<void>;
  onMessage(listener: (message: unknown) => void): void;
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

  constructor(private readonly transport: JsonRpcTransport, options: JsonRpcClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.transport.onMessage((message) => this.handleMessage(message));
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
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

    try {
      await this.transport.send(request);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
      }
      throw error;
    }

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

  private handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const maybeNotification = raw as { method?: unknown; params?: unknown; id?: unknown };
    if (!("id" in maybeNotification) && typeof maybeNotification.method === "string") {
      for (const listener of this.notificationListeners) listener(maybeNotification.method, maybeNotification.params);
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

  dispose(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("JSON-RPC client disposed"));
      this.pending.delete(id);
    }
  }
}
