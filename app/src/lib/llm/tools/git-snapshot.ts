// v0.7 阶段4b 增强 — git 回滚兜底
//
// AI 写/改文件成功后，给该文件单独做一次 git commit，用户随时能 `git revert` 退回。
// best-effort：非 git 仓库 / git 失败都安静返回 false（写操作本身已成功，只是没自动快照）。
// 可注入，便于单测。

import { invoke } from "@tauri-apps/api/core";

export interface GitSnapshotAdapter {
  /** 给单个文件做一次 commit；成功返回 true，非 git 仓库/失败返回 false */
  commitFile(workspace: string, absPath: string, message: string): Promise<boolean>;
  /**
   * 2.1 步骤2/3 修复（2026-07-02）：给非 git 工作文件夹开启"修改保护"——
   * 在应用私有目录初始化一个影子 git 仓库（不在用户文件夹里冒出 `.git`），
   * 之后 commitFile 在这个 workspace 上会自动走影子仓库提交。
   */
  initShadowRepo(workspace: string): Promise<void>;
}

const tauriGitSnapshot: GitSnapshotAdapter = {
  commitFile: (workspace, absPath, message) =>
    invoke<boolean>("git_commit_file", { workspace, relPath: absPath, message }),
  initShadowRepo: (workspace) => invoke<void>("init_shadow_git_repo", { workspace }),
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

/**
 * 2.1 步骤2/3 修复（2026-07-02）：用户点击"开启修改保护"按钮时调用。
 * 抛错交给调用方处理（UI 要能告诉用户"开启失败"，不能像 snapshotWrite 那样静默吞掉——
 * 这是用户主动发起的操作，失败了必须让用户知道，不然会以为开启成功了）。
 */
export async function enableWorkspaceProtection(workspace: string): Promise<void> {
  await getGitSnapshot().initShadowRepo(workspace);
}
