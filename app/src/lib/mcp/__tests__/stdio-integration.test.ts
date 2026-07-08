import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { JsonRpcClient, type JsonRpcTransport } from "@/lib/rpc/rpc-client";
import { encodeNewlineFrame } from "@/lib/rpc/framing";

class NodeNewlineTransport implements JsonRpcTransport {
  private messageListener: ((message: unknown) => void) | null = null;
  private closeListener: (() => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;
  private buffer = "";

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) return;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.messageListener?.(JSON.parse(line));
      }
    });
    child.on("exit", () => this.closeListener?.());
    child.on("error", (error) => this.errorListener?.(error));
  }

  onMessage(listener: (message: unknown) => void): void {
    this.messageListener = listener;
  }

  onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  async send(message: unknown): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(encodeNewlineFrame(JSON.stringify(message)), (error) => (
        error ? reject(error) : resolve()
      ));
    });
  }
}

describe("local MCP stdio real-process integration", () => {
  let directory: string;
  let child: ChildProcessWithoutNullStreams;
  let client: JsonRpcClient;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "cosmgrid-mcp-stdio-"));
    const sdkRoot = join(process.cwd(), "node_modules/@modelcontextprotocol/sdk/dist/esm");
    const script = `
      import { McpServer } from ${JSON.stringify(pathToFileURL(join(sdkRoot, "server/mcp.js")).href)};
      import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(join(sdkRoot, "server/stdio.js")).href)};
      import { z } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "node_modules/zod/index.js")).href)};
      const server = new McpServer({ name: "stdio-fixture", version: "1.0.0" });
      server.registerTool("echo", { inputSchema: { value: z.string() } }, async ({ value }) => ({
        content: [{ type: "text", text: "echo:" + value }],
      }));
      await server.connect(new StdioServerTransport());
    `;
    const scriptPath = join(directory, "server.mjs");
    await writeFile(scriptPath, script);
    child = spawn(process.execPath, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
    client = new JsonRpcClient(new NodeNewlineTransport(child), { timeoutMs: 10_000 });
    await client.call("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "Cosmgrid-Agent-Test", version: "1.0.0" },
    });
    await client.notify("notifications/initialized");
  }, 15_000);

  afterAll(async () => {
    client.dispose();
    child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  });

  it("lists and calls tools over newline-delimited stdio", async () => {
    const listed = await client.call<{ tools?: Array<{ name?: string }> }>("tools/list");
    expect(listed.tools?.map((tool) => tool.name)).toContain("echo");

    const result = await client.call<{ content?: unknown[] }>("tools/call", {
      name: "echo",
      arguments: { value: "hello" },
    });
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "echo:hello" }));
  });
});
