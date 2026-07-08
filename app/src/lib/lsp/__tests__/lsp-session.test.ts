import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  content: "const value: number = 'bad';",
  transports: [] as Array<{
    sent: Array<Record<string, unknown>>;
    emit: (message: unknown) => void;
  }>,
}));

vi.mock("@/lib/llm/tools/fs-adapter", () => ({
  getFsAdapter: () => ({
    readTextFile: vi.fn(async () => state.content),
  }),
}));

vi.mock("../server-detection", () => ({
  detectLspServer: vi.fn(async () => ({
    languageId: "typescript",
    program: "typescript-language-server",
    args: ["--stdio"],
  })),
  languageIdForPath: vi.fn(() => "typescript"),
}));

vi.mock("@/lib/rpc/tauri-transport", () => ({
  TauriRpcTransport: class {
    sent: Array<Record<string, unknown>> = [];
    private listener: ((message: unknown) => void) | null = null;

    constructor() {
      state.transports.push(this);
    }

    onMessage(listener: (message: unknown) => void) {
      this.listener = listener;
    }

    onClose() {}
    onError() {}
    async start() {}
    async dispose() {}

    emit(message: unknown) {
      this.listener?.(message);
    }

    async send(raw: unknown) {
      const message = raw as Record<string, unknown>;
      this.sent.push(message);
      const id = message.id;
      const method = message.method;
      if (id !== undefined) {
        let result: unknown = null;
        if (method === "initialize") result = { capabilities: {} };
        if (method === "textDocument/definition") {
          result = [{
            uri: "file:///workspace/src/definition.ts",
            range: { start: { line: 2, character: 4 } },
          }];
        }
        if (method === "textDocument/hover") {
          result = { contents: { kind: "plaintext", value: "const value: number" } };
        }
        queueMicrotask(() => this.emit({ jsonrpc: "2.0", id, result }));
      }
      if (method === "textDocument/didOpen" || method === "textDocument/didChange") {
        queueMicrotask(() => this.emit({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: {
            uri: "file:///workspace/src/file.ts",
            diagnostics: [{
              range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
              severity: 1,
              source: "ts",
              message: "Type mismatch",
            }],
          },
        }));
      }
    }
  },
}));

const {
  disposeLspSessions,
  getLspDefinition,
  getLspDiagnostics,
  getLspHover,
} = await import("../lsp-session");

describe("lsp-session", () => {
  beforeEach(() => {
    state.content = "const value: number = 'bad';";
  });

  it("opens, refreshes changed content, and returns current diagnostics", async () => {
    await expect(getLspDiagnostics("/workspace", "/workspace/src/file.ts"))
      .resolves.toContain("Type mismatch");

    state.content = "const value: number = 1;";
    await expect(getLspDiagnostics("/workspace", "/workspace/src/file.ts"))
      .resolves.toContain("Type mismatch");

    const methods = state.transports[0]!.sent.map((message) => message.method);
    expect(methods).toContain("textDocument/didOpen");
    expect(methods).toContain("textDocument/didChange");
  });

  it("formats definition and hover responses", async () => {
    await expect(getLspDefinition("/workspace", "/workspace/src/file.ts", 1, 1))
      .resolves.toContain("definition.ts:3:5");
    await expect(getLspHover("/workspace", "/workspace/src/file.ts", 1, 1))
      .resolves.toContain("const value: number");
  });

  it("gracefully shuts down active sessions", async () => {
    await disposeLspSessions();
    const methods = state.transports[0]!.sent.map((message) => message.method);
    expect(methods).toContain("shutdown");
    expect(methods).toContain("exit");
  });
});
