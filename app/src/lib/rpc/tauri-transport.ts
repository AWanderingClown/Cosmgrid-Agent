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
  // 2026-07-15 review 修复：原来 onClose/onError 各自只存一个函数引用，后注册的会覆盖先
  // 注册的。JsonRpcClient 的构造函数会注册一份（用来 reject 所有 pending 调用），会话缓存层
  // （lsp-session.ts / mcp/client.ts）现在也要注册一份（用来在进程终止/报错时把自己从缓存
  // 里 evict 掉，否则下次调用会一直复用一个指向已死进程的缓存条目，只有重启 app 才能恢复）
  // ——两者必须都能收到通知，不能互相覆盖，改成数组存多个监听器。
  private closeListeners: Array<() => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];
  private unlisten: Promise<UnlistenFn> | null = null;

  constructor(private readonly options: TauriRpcTransportOptions) {}

  onMessage(listener: (message: unknown) => void): void {
    this.listener = listener;
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  async start(): Promise<void> {
    this.unlisten = listen<RpcProcessEventPayload>("rpc-process-event", (event) => {
      const payload = event.payload;
      if (payload.sessionId !== this.options.sessionId) return;
      if (payload.type === "terminated") {
        for (const l of this.closeListeners) l();
        return;
      }
      if (payload.type === "error") {
        const error = new Error(payload.message ?? "RPC process error");
        for (const l of this.errorListeners) l(error);
        return;
      }
      if (payload.type !== "message" || typeof payload.message !== "string") return;
      try {
        this.listener?.(JSON.parse(payload.message));
      } catch {
        const error = new Error("RPC process emitted malformed JSON");
        for (const l of this.errorListeners) l(error);
      }
    });
    await invoke("spawn_rpc_process", {
      params: {
        sessionId: this.options.sessionId,
        program: this.options.program,
        args: this.options.args ?? [],
        extraEnv: this.options.env ?? {},
        workingDirectory: this.options.cwd ?? null,
        framing: this.options.framing,
      },
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
