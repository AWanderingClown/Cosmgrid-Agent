import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  eventHandler: null as ((event: { payload: unknown }) => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen.mockImplementation(async (_event: string, handler: typeof mocks.eventHandler) => {
    mocks.eventHandler = handler;
    return mocks.unlisten;
  }),
}));

const { TauriRpcTransport } = await import("../tauri-transport");

describe("TauriRpcTransport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventHandler = null;
    mocks.invoke.mockResolvedValue(undefined);
  });

  function transport(framing: "content-length" | "newline" = "newline") {
    return new TauriRpcTransport({
      sessionId: "session-1",
      program: "node",
      args: ["server.js"],
      cwd: "/workspace",
      env: { TOKEN: "secret" },
      framing,
    });
  }

  it("starts the RPC process and parses matching message events", async () => {
    const instance = transport();
    const onMessage = vi.fn();
    instance.onMessage(onMessage);
    await instance.start();

    expect(mocks.invoke).toHaveBeenCalledWith("spawn_rpc_process", expect.objectContaining({
      sessionId: "session-1",
      program: "node",
      framing: "newline",
    }));
    mocks.eventHandler?.({ payload: { type: "message", sessionId: "other", message: "{}" } });
    mocks.eventHandler?.({ payload: { type: "message", sessionId: "session-1", message: '{"ok":true}' } });
    expect(onMessage).toHaveBeenCalledWith({ ok: true });
  });

  it("surfaces malformed JSON, process errors, and termination", async () => {
    const instance = transport();
    const onError = vi.fn();
    const onClose = vi.fn();
    instance.onMessage(() => {});
    instance.onError(onError);
    instance.onClose(onClose);
    await instance.start();

    mocks.eventHandler?.({ payload: { type: "message", sessionId: "session-1", message: "bad-json" } });
    mocks.eventHandler?.({ payload: { type: "error", sessionId: "session-1", message: "read failed" } });
    mocks.eventHandler?.({ payload: { type: "terminated", sessionId: "session-1", code: 1 } });
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("writes both supported frame formats and disposes", async () => {
    const newline = transport("newline");
    await newline.start();
    await newline.send({ jsonrpc: "2.0", method: "ping" });
    expect(mocks.invoke).toHaveBeenCalledWith("write_rpc_stdin", expect.objectContaining({
      payload: '{"jsonrpc":"2.0","method":"ping"}\n',
    }));

    const contentLength = transport("content-length");
    await contentLength.start();
    await contentLength.send({ ok: true });
    expect(mocks.invoke).toHaveBeenCalledWith("write_rpc_stdin", expect.objectContaining({
      payload: "Content-Length: 11\r\n\r\n{\"ok\":true}",
    }));

    await contentLength.dispose();
    expect(mocks.unlisten).toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("kill_rpc_process", { sessionId: "session-1" });
  });
});
