// v0.7 阶段4b — shell 执行适配器
//
// 把 Rust run_shell_command 包一层（可注入），bash 工具依赖接口而非直接依赖 Tauri，便于单测。
// 安全前置（白名单/拦截/确认）在 bash 工具里做；本适配器只负责执行已批准的命令。

import { invoke } from "@tauri-apps/api/core";

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface ShellAdapter {
  run(command: string, cwd: string): Promise<ShellResult>;
}

export const tauriShell: ShellAdapter = {
  run: (command, cwd) => invoke<ShellResult>("run_shell_command", { command, cwd }),
};

let active: ShellAdapter = tauriShell;

export function getShellAdapter(): ShellAdapter {
  return active;
}

export function setShellAdapter(a: ShellAdapter): void {
  active = a;
}
