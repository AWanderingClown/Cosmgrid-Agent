// hashline 模块的桶导出——移植自 oh-my-openagent 的 hashline-core（详见各文件头注释）。
export { NIBBLE_STR, HASHLINE_DICT, HASHLINE_REF_PATTERN, HASHLINE_OUTPUT_PATTERN } from "./constants";
export type { ReplaceEdit, AppendEdit, PrependEdit, HashlineEdit } from "./types";
export { computeLineHash, computeLegacyLineHash, formatHashLine, formatHashLines } from "./hash-computation";
export { parseLineRef, validateLineRef, validateLineRefs, HashlineMismatchError, normalizeLineRef } from "./validation";
export type { LineRef } from "./validation";
export { applyHashlineEdits, applyHashlineEditsWithReport } from "./edit-operations";
export type { HashlineApplyReport } from "./edit-operations";
export {
  applySetLine,
  applyReplaceLines,
  applyInsertAfter,
  applyInsertBefore,
  applyAppend,
  applyPrepend,
} from "./edit-operation-primitives";
export { getEditLineNumber, collectLineRefs, detectOverlappingRanges } from "./edit-ordering";
export { dedupeEdits } from "./edit-deduplication";
export {
  stripLinePrefixes,
  toNewLines,
  restoreLeadingIndent,
  stripInsertAnchorEcho,
  stripInsertBeforeEcho,
  stripInsertBoundaryEcho,
  stripRangeBoundaryEcho,
} from "./edit-text-normalization";
export { normalizeHashlineEdits } from "./normalize-edits";
export type { RawHashlineEdit } from "./normalize-edits";
