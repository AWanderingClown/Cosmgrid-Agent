// 原样移植自 hashline-core/src/xxhash32.ts——runtime-aware xxHash32：
// 有 Bun 原生绑定就用它，否则退回纯 JS 实现。浏览器/Tauri webview 环境下 globalThis.Bun
// 不存在，走纯 JS 分支，行为跟 Node/Bun 端算出来的 hash 完全一致（同一套算法）。

type BunHashRuntime = { hash: { xxHash32(data: string | Uint8Array, seed: number): number } };

const runtime = globalThis as typeof globalThis & { Bun?: BunHashRuntime };
const encoder = new TextEncoder();

const PRIME32_1 = 0x9e3779b1;
const PRIME32_2 = 0x85ebca77;
const PRIME32_3 = 0xc2b2ae3d;
const PRIME32_4 = 0x27d4eb2f;
const PRIME32_5 = 0x165667b1;

function rotateLeft32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function readUint32LittleEndian(input: Uint8Array, offset: number): number {
  return (
    ((input[offset] ?? 0) |
      ((input[offset + 1] ?? 0) << 8) |
      ((input[offset + 2] ?? 0) << 16) |
      ((input[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function round32(accumulator: number, value: number): number {
  const added = (accumulator + Math.imul(value, PRIME32_2)) >>> 0;
  return Math.imul(rotateLeft32(added, 13), PRIME32_1) >>> 0;
}

function xxHash32Js(input: Uint8Array, seed: number): number {
  let offset = 0;
  const length = input.length;
  let hash: number;

  if (length >= 16) {
    const limit = length - 16;
    let value1 = (seed + PRIME32_1 + PRIME32_2) >>> 0;
    let value2 = (seed + PRIME32_2) >>> 0;
    let value3 = seed >>> 0;
    let value4 = (seed - PRIME32_1) >>> 0;

    while (offset <= limit) {
      value1 = round32(value1, readUint32LittleEndian(input, offset));
      offset += 4;
      value2 = round32(value2, readUint32LittleEndian(input, offset));
      offset += 4;
      value3 = round32(value3, readUint32LittleEndian(input, offset));
      offset += 4;
      value4 = round32(value4, readUint32LittleEndian(input, offset));
      offset += 4;
    }

    hash = (rotateLeft32(value1, 1) + rotateLeft32(value2, 7)) >>> 0;
    hash = (hash + rotateLeft32(value3, 12)) >>> 0;
    hash = (hash + rotateLeft32(value4, 18)) >>> 0;
  } else {
    hash = (seed + PRIME32_5) >>> 0;
  }

  hash = (hash + length) >>> 0;

  while (offset + 4 <= length) {
    hash = (hash + Math.imul(readUint32LittleEndian(input, offset), PRIME32_3)) >>> 0;
    hash = Math.imul(rotateLeft32(hash, 17), PRIME32_4) >>> 0;
    offset += 4;
  }

  while (offset < length) {
    hash = (hash + Math.imul(input[offset] ?? 0, PRIME32_5)) >>> 0;
    hash = Math.imul(rotateLeft32(hash, 11), PRIME32_1) >>> 0;
    offset += 1;
  }

  hash = (hash ^ (hash >>> 15)) >>> 0;
  hash = Math.imul(hash, PRIME32_2) >>> 0;
  hash = (hash ^ (hash >>> 13)) >>> 0;
  hash = Math.imul(hash, PRIME32_3) >>> 0;

  return (hash ^ (hash >>> 16)) >>> 0;
}

export function hashXxh32(input: string, seed: number): number {
  const bun = runtime.Bun;
  if (bun !== undefined) {
    return bun.hash.xxHash32(input, seed);
  }
  return xxHash32Js(encoder.encode(input), seed >>> 0);
}
