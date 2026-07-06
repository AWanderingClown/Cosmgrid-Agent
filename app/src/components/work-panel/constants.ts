// 阶段 J 修（review 铁律 3：漂移清单）：MAX_DETAIL_LINES 单一来源
// 之前 WorkArtifacts.tsx:13 + DiffView.tsx:16 两处字面量 40，漂移风险
// 现在所有 work-panel 子组件都从此处 import
export const MAX_DETAIL_LINES = 40;
export const HTML_SRC_LIMIT = 200_000; // html 工件超过 200KB 降级显示 source（防 srcDoc 卡顿）
