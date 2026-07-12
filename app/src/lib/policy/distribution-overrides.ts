/**
 * 引擎化改造方案 §5.2 K2：distribution scope 的数据源。
 *
 * distribution 是介于 builtin（硬编码兜底）和 project/global（用户运行时在 UI 改）之间的
 * “发布通道内置层”：发布方 / 运营侧在这里调整策略默认值——改的是**数据不是逻辑代码**，
 * 改完随构建发布即可，不需要碰各策略的 TS 实现，也不需要用户操作。用户在 UI 里切不到
 * 这一档（PolicyStore 只让 get 读它，set/reset 不经此路径）。
 *
 * 覆盖谁：所有 scopesAllowed 含 "distribution" 的策略——
 *   provider.error_patterns / message.router.markers / intent.action_markers /
 *   user_tier.baseline / debate.markers
 *
 * 怎么填：key = 策略 key；value = 该策略 override 的结构（与各策略 parse() 接受的 JSON 同构，
 * 会经该策略的 zod schema 校验，写错结构会在 hydrate 时被 parse 拒绝并安全兜底回 builtin）。
 * 空对象 = 无任何 distribution 覆盖，全部策略走各自 builtin（当前默认）。
 *
 * 例（给 provider 错误表新增一个 provider，不改代码、不发新逻辑、不重构建以外的动作）：
 *   "provider.error_patterns": {
 *     "newprovider": {
 *       rateLimitStatusCodes: [429], authStatusCodes: [401],
 *       contextOverflowStatusCodes: [413], modelNotFoundStatusCodes: [404],
 *       rateLimitKeywords: ["额度不足"], authKeywords: ["鉴权失败"],
 *       contextOverflowKeywords: ["上下文过长"], modelNotFoundKeywords: ["模型不存在"],
 *     },
 *   }
 */
export const DISTRIBUTION_OVERRIDES: Readonly<Record<string, unknown>> = {
  // 默认空：不覆盖任何策略。发布方按需在此添加。
};

/**
 * 取某策略在 distribution 层的 override，序列化成 value_json（与 DB policy_overrides 存储格式一致，
 * 让 PolicyStore.get 对上下游都返回同一种 raw JSON 形态）。没有配置 → null（调用方兜底 builtin）。
 */
export function getDistributionOverrideJson(policyKey: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(DISTRIBUTION_OVERRIDES, policyKey)) return null;
  return JSON.stringify(DISTRIBUTION_OVERRIDES[policyKey]);
}
