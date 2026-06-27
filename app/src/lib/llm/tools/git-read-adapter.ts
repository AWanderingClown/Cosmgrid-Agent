// v0.7 增强-2 — 只读 git 查询适配器
//
// 把 Rust git_read 命令包一层（可注入），git-read 工具依赖接口而非直接依赖 Tauri，便于单测。
// 子命令白名单 + 参数构造在 git-read 工具里做；本适配器只负责执行已构造好的只读 git 命令。

import { invoke } from "@tauri-apps/api/core";
import type { ShellResult } from "./shell-adapter";

export interface GitReadAdapter {
  /** 在 workspace 目录里跑 `git <args>`，捕获 stdout/stderr/exit code */
  run(workspace: string, args: string[]): Promise<ShellResult>;
}

const tauriGitRead: GitReadAdapter = {
  run: (workspace, args) => invoke<ShellResult>("git_read", { workspace, args }),
};

let active: GitReadAdapter = tauriGitRead;

export function getGitReadAdapter(): GitReadAdapter {
  return active;
}

export function setGitReadAdapter(a: GitReadAdapter): void {
  active = a;
}
