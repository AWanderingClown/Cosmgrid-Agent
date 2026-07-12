// 用户主观模型分级基线（2026-06-25 用户提供，拍脑袋但实际用过，比名字查表准）。
//
// 引擎化改造方案 §6 阶段 3：常量搬到 lib/policy/user-tier-baseline.ts (BUILTIN_USER_TIER_BASELINE)。
// 本文件保留老 API re-export（用 const 而非 alias export，确保 type 信息传递），所有现存调用方零改动。
//
// review S-F-12（2026-07-13）备注：历史代码里常见 import { USER_TIER_BASELINE } 这个名字——
// 本文件留 alias 保持兼容性。新代码请用 BUILTIN_USER_TIER_BASELINE（带前缀区分）
// + 显式 import 自 @/lib/policy/user-tier-baseline，避免 grep "USER_TIER_BASELINE"
// 时混淆两个文件里的 const。

import {
  BUILTIN_USER_TIER_BASELINE as _BUILTIN,
  USER_TIER_BASELINE_KEY,
  resolveUserTierBaseline,
  scoreByUserBaseline,
  type UserTierEntry,
} from "@/lib/policy/user-tier-baseline";

export {
  USER_TIER_BASELINE_KEY,
  resolveUserTierBaseline,
  scoreByUserBaseline,
  type UserTierEntry,
};

/** 老命名兼容 —— 历史 import "USER_TIER_BASELINE" 的代码不需要改动。 */
export const USER_TIER_BASELINE: ReadonlyArray<UserTierEntry> = _BUILTIN;
