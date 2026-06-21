// v0.9 阶段7 — 应用级开关（localStorage 持久化）
//
// 目前只有「智能路由 v2」开关。v2 是叠加在 v1 之上的可选增强：
// 关掉后行为退回纯 v1 规则路由 + 不查语义缓存（产品真北：用户始终可一键覆盖）。
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
