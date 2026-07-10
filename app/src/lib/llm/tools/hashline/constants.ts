// 哈希锚定编辑（hashline）——移植自 oh-my-openagent 的 hashline-core（纯 TS，无外部依赖）。
// 用途：Read 给每行打 {行号}#{2位hash} 指纹，Edit 按该指纹引用定位，取代脆弱的
// 字符串/行号裸定位——文件在多轮之间变了会被 hash 校验直接拦下，而不是改错地方。

export const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";

export const HASHLINE_DICT: string[] = Array.from({ length: 256 }, (_, i) => {
  const high = i >>> 4;
  const low = i & 0x0f;
  return `${NIBBLE_STR[high]}${NIBBLE_STR[low]}`;
});

export const HASHLINE_REF_PATTERN = /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})$/;
export const HASHLINE_OUTPUT_PATTERN = /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})\|(.*)$/;
