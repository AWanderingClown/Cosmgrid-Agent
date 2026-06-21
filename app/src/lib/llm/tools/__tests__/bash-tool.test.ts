// bash 工具单测（v0.7 阶段4b：安全闸 + 执行）
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setShellAdapter, type ShellAdapter } from "../shell-adapter";
import { bashTool } from "../bash-tool";
import type { ToolContext } from "../types";

let runSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  runSpy = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", code: 0 });
  const adapter: ShellAdapter = { run: runSpy as any };
  setShellAdapter(adapter);
});

function ctx(confirm?: ToolContext["confirm"], blocked?: string[]): ToolContext {
  return { workspacePath: "/ws", ...(confirm ? { confirm } : {}), ...(blocked ? { blockedCommands: blocked } : {}) };
}

describe("bash 工具 — 安全闸", () => {
  it("危险命令被拦截，不弹确认、不执行", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await bashTool.execute({ command: "rm -rf /" }, ctx(confirm));
    expect(r.status).toBe("denied");
    expect(confirm).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("非白名单命令被拦截", async () => {
    const r = await bashTool.execute({ command: "brew install x" }, ctx(vi.fn().mockResolvedValue(true)));
    expect(r.status).toBe("denied");
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("项目黑名单命中拦截", async () => {
    const r = await bashTool.execute({ command: "pnpm deploy" }, ctx(vi.fn().mockResolvedValue(true), ["deploy"]));
    expect(r.status).toBe("denied");
  });

  it("无确认通道 → 拒绝，不执行", async () => {
    const r = await bashTool.execute({ command: "pnpm test" }, ctx());
    expect(r.status).toBe("denied");
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("用户拒绝 → 不执行", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const r = await bashTool.execute({ command: "pnpm test" }, ctx(confirm));
    expect(r.status).toBe("denied");
    expect(runSpy).not.toHaveBeenCalled();
  });
});

describe("bash 工具 — 执行", () => {
  it("白名单 + 确认 → 在 workspace 执行，返回 stdout + exit", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await bashTool.execute({ command: "pnpm test" }, ctx(confirm));
    expect(r.status).toBe("success");
    expect(runSpy).toHaveBeenCalledWith("pnpm test", "/ws");
    expect(r.output).toContain("ok");
    expect(r.output).toContain("exit code: 0");
  });

  it("非零退出码 → status=error", async () => {
    runSpy.mockResolvedValue({ stdout: "", stderr: "test failed", code: 1 });
    const r = await bashTool.execute({ command: "pnpm test" }, ctx(vi.fn().mockResolvedValue(true)));
    expect(r.status).toBe("error");
    expect(r.output).toContain("stderr");
    expect(r.output).toContain("exit code: 1");
  });

  it("执行抛错 → status=error", async () => {
    runSpy.mockRejectedValue(new Error("spawn failed"));
    const r = await bashTool.execute({ command: "git status" }, ctx(vi.fn().mockResolvedValue(true)));
    expect(r.status).toBe("error");
    expect(r.output).toMatch(/spawn failed/);
  });
});
