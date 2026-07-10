// v0.7 阶段4 — 文件系统适配器
//
// 把 @tauri-apps/plugin-fs 包一层（可注入），让工具依赖接口而非直接依赖 Tauri——
// 单测时换成内存假实现，无需真实文件系统 / Tauri 运行时。

import { readTextFile, readFile, readDir, exists, writeTextFile, mkdir } from "@tauri-apps/plugin-fs";

export interface FsDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface FsAdapter {
  readTextFile(path: string): Promise<string>;
  /** 读二进制文件（view_image 工具用）；返回 Uint8Array */
  readBytes(path: string): Promise<Uint8Array>;
  readDir(path: string): Promise<FsDirEntry[]>;
  exists(path: string): Promise<boolean>;
  writeTextFile(path: string, content: string): Promise<void>;
  /** 递归创建目录（写文件前确保父目录存在） */
  mkdirp(path: string): Promise<void>;
}

/** 生产实现：走 Tauri plugin-fs（已在 Rust 注册 + capabilities 授权 $HOME/**） */
export const tauriFs: FsAdapter = {
  readTextFile: (path) => readTextFile(path),
  readBytes: (path) => readFile(path),
  readDir: async (path) => {
    const entries = await readDir(path);
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory,
      isFile: e.isFile,
    }));
  },
  exists: (path) => exists(path),
  writeTextFile: (path, content) => writeTextFile(path, content),
  mkdirp: (path) => mkdir(path, { recursive: true }),
};

let active: FsAdapter = tauriFs;

export function getFsAdapter(): FsAdapter {
  return active;
}

/** 替换适配器（测试用） */
export function setFsAdapter(a: FsAdapter): void {
  active = a;
}
