// 防编造功能的共享常量与共享类型 —— 避免在 fabrication-judge / fabrication-evidence
// / feedback 三处文件里散落同一组 magic number，导致阈值漂移。
//
// 命名规范：FABRICATION_<SCOPE>_<LIMIT>，全大写 + export，便于 grep。

/** LLM 语义裁判达到该置信度才判定为编造（漏报优于误报，同 harness 总原则）。 */
export const FABRICATION_CONFIDENCE_THRESHOLD = 0.7;

/** 正则全 clean + 正文太短不送裁判（塞不下具体结果）。 */
export const FABRICATION_MIN_CONTENT_LEN = 40;

/** fabrication judge prompt 里截取的 AI 回答字符上限。 */
export const FABRICATION_CONTENT_MAX = 4000;

/** fabrication judge 单条工具 output 截断上限。 */
export const FABRICATION_PER_OUTPUT_MAX = 600;

/** fabrication judge 单条工具 input 截断上限（input 通常比 output 短）。 */
export const FABRICATION_PER_INPUT_MAX = 200;

/** fabrication judge LLM 输出 token 上限（schema 只 5 字段，200 token 足够）。 */
export const FABRICATION_JUDGE_MAX_OUTPUT_TOKENS = 200;

/** fabrication judge 总摘要字符上限（防止 prompt 被撑爆）。 */
export const FABRICATION_TOTAL_MAX = 4000;

/** fabrication 裁判命中字段——一处定义，HarnessVerdict / HarnessWarning / judgeFabrication 复用。 */
export interface FabricationSuspicion {
  claimedActions: string[];
  reason: string;
}
