// v0.7 阶段4 — 文件系统适配器
//
// 把 @tauri-apps/plugin-fs 包一层（可注入），让工具依赖接口而非直接依赖 Tauri——
// 单测时换成内存假实现，无需真实文件系统 / Tauri 运行时。

import { readTextFile, readDir, exists } from "@tauri-apps/plugin-fs";

export interface FsDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface FsAdapter {
  readTextFile(path: string): Promise<string>;
  readDir(path: string): Promise<FsDirEntry[]>;
  exists(path: string): Promise<boolean>;
}

/** 生产实现：走 Tauri plugin-fs（已在 Rust 注册 + capabilities 授权 $HOME/**） */
export const tauriFs: FsAdapter = {
  readTextFile: (path) => readTextFile(path),
  readDir: async (path) => {
    const entries = await readDir(path);
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory,
      isFile: e.isFile,
    }));
  },
  exists: (path) => exists(path),
};

let active: FsAdapter = tauriFs;

export function getFsAdapter(): FsAdapter {
  return active;
}

/** 替换适配器（测试用） */
export function setFsAdapter(a: FsAdapter): void {
  active = a;
}
