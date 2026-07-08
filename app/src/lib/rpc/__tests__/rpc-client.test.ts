import { describe, expect, it, vi } from "vitest";
import { JsonRpcClient, type JsonRpcTransport } from "../rpc-client";

class FakeTransport implements JsonRpcTransport {
  readonly sent: string[] = [];
  private listener: ((message: unknown) => void) | null = null;

  onMessage(listener: (message: unknown) => void): void {
    this.listener = listener;
  }

  async send(message: unknown): Promise<void> {
    this.sent.push(JSON.stringify(message));
  }

  emit(message: unknown): void {
    this.listener?.(message);
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
});
