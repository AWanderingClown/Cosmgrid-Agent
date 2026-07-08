import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { encodeContentLengthFrame, encodeNewlineFrame } from "./framing";
import type { JsonRpcTransport } from "./rpc-client";

export type RpcFraming = "content-length" | "newline";

interface RpcProcessEventPayload {
  type: "message" | "stderr" | "terminated" | "error";
  sessionId: string;
  message?: string;
  line?: string;
  code?: number | null;
}

export interface TauriRpcTransportOptions {
  sessionId: string;
  program: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  framing: RpcFraming;
}

export class TauriRpcTransport implements JsonRpcTransport {
  private listener: ((message: unknown) => void) | null = null;
  private unlisten: Promise<UnlistenFn> | null = null;

  constructor(private readonly options: TauriRpcTransportOptions) {}

  onMessage(listener: (message: unknown) => void): void {
    this.listener = listener;
  }

  async start(): Promise<void> {
    this.unlisten = listen<RpcProcessEventPayload>("rpc-process-event", (event) => {
      const payload = event.payload;
      if (payload.sessionId !== this.options.sessionId) return;
      if (payload.type !== "message" || typeof payload.message !== "string") return;
      try {
        this.listener?.(JSON.parse(payload.message));
      } catch {
        // Ignore malformed server output; stderr/error events still surface via devtools/logs.
      }
    });
    await invoke("spawn_rpc_process", {
      sessionId: this.options.sessionId,
      program: this.options.program,
      args: this.options.args ?? [],
      extraEnv: this.options.env ?? {},
      workingDirectory: this.options.cwd ?? null,
      framing: this.options.framing,
    });
  }

  async send(message: unknown): Promise<void> {
    const json = JSON.stringify(message);
    const payload = this.options.framing === "content-length"
      ? encodeContentLengthFrame(json)
      : encodeNewlineFrame(json);
    await invoke("write_rpc_stdin", { sessionId: this.options.sessionId, payload });
  }

  async dispose(): Promise<void> {
    const unlisten = await this.unlisten;
    unlisten?.();
    await invoke("kill_rpc_process", { sessionId: this.options.sessionId }).catch(() => false);
  }
}
