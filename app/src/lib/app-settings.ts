// v0.9 阶段7 — 应用级开关（localStorage 持久化）
//
// 目前有「智能路由 v2」开关 + 「权限档」持久化：
// - 智能路由 v2 是叠加在 v1 之上的可选增强：关掉后行为退回纯 v1 规则路由 + 不查语义缓存
//   （产品真北：用户始终可一键覆盖）
// - 权限档（read/confirm/auto）持久化：用户选过哪档就记哪档，关应用重启不丢
//   （教训：默认 read 容易让新用户首轮以为"工具坏了"，记忆化能直接消除这个踩坑）
import { useEffect, useState } from "react";

const SMART_ROUTING_KEY = "cosmgrid.smartRouting";

/** 智能路由（v2）是否开启。默认开；只有显式存 "off" 才算关。 */
export function isSmartRoutingEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(SMART_ROUTING_KEY) !== "off";
}

export function setSmartRoutingEnabled(on: boolean): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(SMART_ROUTING_KEY, on ? "on" : "off");
}

/** React hook 版：组件里读写开关 */
export function useSmartRoutingSetting(): [boolean, (on: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(isSmartRoutingEnabled);

  useEffect(() => {
    setSmartRoutingEnabled(enabled);
  }, [enabled]);

  return [enabled, setEnabled];
}

// —— 权限档（read / confirm / auto）持久化 ——
export type PermissionMode = "read" | "confirm" | "auto";

const PERMISSION_MODE_KEY = "cosmgrid.permissionMode";
const VALID_PERMISSION_MODES: readonly PermissionMode[] = ["read", "confirm", "auto"];

/** 读权限档。默认 read；localStorage 脏写（不是三档之一）也降级回 read，绝不让 UI 拿到非法值 */
export function getPermissionMode(): PermissionMode {
  if (typeof localStorage === "undefined") return "read";
  const raw = localStorage.getItem(PERMISSION_MODE_KEY);
  if (raw && (VALID_PERMISSION_MODES as readonly string[]).includes(raw)) {
    return raw as PermissionMode;
  }
  return "read";
}

export function setPermissionMode(mode: PermissionMode): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PERMISSION_MODE_KEY, mode);
}

/** React hook 版：组件里读写权限档。setter 同步落 localStorage，重启保留用户习惯 */
export function usePermissionModeSetting(): [PermissionMode, (mode: PermissionMode) => void] {
  const [mode, setModeState] = useState<PermissionMode>(getPermissionMode);

  // 用 ref 镜像当前 mode，避免 useEffect 在 mount 时把默认值再写一次 localStorage
  // （getPermissionMode 已默认 read，首次不写也行；这里 effect 只在 mode 变化时同步）
  useEffect(() => {
    setPermissionMode(mode);
  }, [mode]);

  return [mode, setModeState];
}
