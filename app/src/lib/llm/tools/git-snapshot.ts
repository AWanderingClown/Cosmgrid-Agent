// v0.7 阶段4b 增强 — git 回滚兜底
//
// AI 写/改文件成功后，给该文件单独做一次 git commit，用户随时能 `git revert` 退回。
// best-effort：非 git 仓库 / git 失败都安静返回 false（写操作本身已成功，只是没自动快照）。
// 可注入，便于单测。

import { invoke } from "@tauri-apps/api/core";

export interface GitSnapshotAdapter {
  /** 给单个文件做一次 commit；成功返回 true，非 git 仓库/失败返回 false */
  commitFile(workspace: string, absPath: string, message: string): Promise<boolean>;
}

const tauriGitSnapshot: GitSnapshotAdapter = {
  commitFile: (workspace, absPath, message) =>
    invoke<boolean>("git_commit_file", { workspace, relPath: absPath, message }),
};

let active: GitSnapshotAdapter = tauriGitSnapshot;

function getGitSnapshot(): GitSnapshotAdapter {
  return active;
}

export function setGitSnapshot(a: GitSnapshotAdapter): void {
  active = a;
}

/** 写操作后做快照。返回是否提交成功（=可回滚）。永不抛错。 */
export async function snapshotWrite(
  workspace: string,
  absPath: string,
  tool: string,
): Promise<boolean> {
  try {
    return await getGitSnapshot().commitFile(workspace, absPath, `cosmgrid-agent: ${tool} ${absPath}`);
  } catch {
    return false;
  }
}
