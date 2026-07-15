import { describe, expect, it, vi } from "vitest";
import { JsonRpcClient, type JsonRpcTransport } from "../rpc-client";

class FakeTransport implements JsonRpcTransport {
  readonly sent: string[] = [];
  private listener: ((message: unknown) => void) | null = null;
  private closeListener: (() => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;

  onMessage(listener: (message: unknown) => void): void {
    this.listener = listener;
  }

  onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  async send(message: unknown): Promise<void> {
    this.sent.push(JSON.stringify(message));
  }

  emit(message: unknown): void {
    this.listener?.(message);
  }

  close(): void {
    this.closeListener?.();
  }

  fail(error: Error): void {
    this.errorListener?.(error);
  }
}

describe("JsonRpcClient", () => {
  it("resolves calls by JSON-RPC id", async () => {
    const transport = new FakeTransport();
    const client = new JsonRpcClient(transport, { timeoutMs: 1000 });
    const promise = client.call("tools/list", { cursor: null });

    const request = JSON.parse(transport.sent[0]!);
    expect(request).toMatchObject({ jsonrpc: "2.0", method: "tools/list", params: { cursor: null } });

    transport.emit({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
    await expect(promise).resolves.toEqual({ tools: [] });
  });

  it("rejects calls on JSON-RPC error responses", async () => {
    const transport = new FakeTransport();
    const client = new JsonRpcClient(transport, { timeoutMs: 1000 });
    const promise = client.call("bad");
    const request = JSON.parse(transport.sent[0]!);

    transport.emit({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "missing" } });

    await expect(promise).rejects.toThrow("missing");
  });

  it("emits notifications without creating pending calls", async () => {
    const transport = new FakeTransport();
    const client = new JsonRpcClient(transport);

    await client.notify("initialized", {});

    expect(JSON.parse(transport.sent[0]!)).toEqual({ jsonrpc: "2.0", method: "initialized", params: {} });
  });

  it("times out unanswered calls", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const client = new JsonRpcClient(transport, { timeoutMs: 50 });
      const promise = client.call("slow");
      const assertion = expect(promise).rejects.toThrow("timed out");

      await vi.advanceTimersByTimeAsync(51);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects pending calls immediately when the transport closes", async () => {
    const transport = new FakeTransport();
    const client = new JsonRpcClient(transport, { timeoutMs: 10_000 });
    const promise = client.call("long-running");
    transport.close();
    await expect(promise).rejects.toThrow("transport closed");
  });

  it("rejects pending calls with transport errors", async () => {
    const transport = new FakeTransport();
    const client = new JsonRpcClient(transport, { timeoutMs: 10_000 });
    const promise = client.call("long-running");
    transport.fail(new Error("process crashed"));
    await expect(promise).rejects.toThrow("process crashed");
  });

  // 2026-07-15 review 修复回归测试：transport.send() 本身永久挂起（对应 Rust 侧
  // write_rpc_stdin 因子进程不读 stdin 而卡死的场景）。旧实现在 `return promise` 之前
  // `await transport.send()`，send() 卡住时 call() 永远走不到 return，调用方拿不到那个
  // 会被 timeout 保护的 promise 引用，表现为永久挂起而不是超时错误。
  it("send() 永久挂起时仍能被超时兜底，不会导致调用方永久挂起", async () => {
    vi.useFakeTimers();
    try {
      class HangingTransport implements JsonRpcTransport {
        onMessage(): void {}
        onClose(): void {}
        onError(): void {}
        send(): Promise<void> {
          return new Promise(() => {}); // 永远不 resolve/reject，模拟 write_rpc_stdin 卡死
        }
      }
      const transport = new HangingTransport();
      const client = new JsonRpcClient(transport, { timeoutMs: 50 });
      const promise = client.call("stuck");
      const assertion = expect(promise).rejects.toThrow("timed out");

      await vi.advanceTimersByTimeAsync(51);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("send() 失败（同步/异步拒绝）时正确清理 pending 并 reject，不留下悬空计时器", async () => {
    class RejectingTransport implements JsonRpcTransport {
      onMessage(): void {}
      onClose(): void {}
      onError(): void {}
      send(): Promise<void> {
        return Promise.reject(new Error("write_rpc_stdin failed"));
      }
    }
    const transport = new RejectingTransport();
    const client = new JsonRpcClient(transport, { timeoutMs: 10_000 });
    const promise = client.call("bad-write");
    await expect(promise).rejects.toThrow("write_rpc_stdin failed");
  });

  it("responds to server-initiated requests", async () => {
    const transport = new FakeTransport();
    const client = new JsonRpcClient(transport);
    client.onRequest("workspace/configuration", async () => [null]);

    transport.emit({
      jsonrpc: "2.0",
      id: 99,
      method: "workspace/configuration",
      params: { items: [{}] },
    });
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    expect(JSON.parse(transport.sent[0]!)).toEqual({
      jsonrpc: "2.0",
      id: 99,
      result: [null],
    });
  });

  it("returns method-not-found for unsupported server requests", async () => {
    const transport = new FakeTransport();
    new JsonRpcClient(transport);

    transport.emit({ jsonrpc: "2.0", id: "server-1", method: "unknown/request" });
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    expect(JSON.parse(transport.sent[0]!)).toMatchObject({
      jsonrpc: "2.0",
      id: "server-1",
      error: { code: -32601 },
    });
  });
});
