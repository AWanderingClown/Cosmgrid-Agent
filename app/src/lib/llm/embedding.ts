// v0.9 阶段7 — 文本向量化（语义缓存检索用）
//
// 决策点②：transformers.js（all-mpnet-base-v2，110MB）在 Tauri WebView 兼容性未验证，
// 且体积大。先实现「零依赖关键词哈希 embedding」作默认 provider——语义缓存今天就能真跑；
// 接口留好（EmbeddingProvider），日后 spike 通过可无缝换 transformers.js（v0.9.1）。
//
// 关键词哈希 embedding 原理：把文本切成 token（拉丁词 + CJK 单字 + CJK 二元组），
// 每个 token 哈希到固定维度的桶里累加，再 L2 归一化。同义改写共享 token → 余弦高；
// 无关文本 token 几乎不重叠 → 余弦低。质量不如神经 embedding，但确定性、离线、零成本。

export interface EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  embed(text: string): Promise<number[]>;
}

const DEFAULT_DIM = 256;

/** 简单字符串哈希（FNV-1a 变体），返回非负整数 */
function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const LATIN_WORD = /[a-z0-9]+/g;
const CJK_CHAR = /[一-鿿]/g;

/** 把文本切成 token：拉丁词 + CJK 单字 + CJK 相邻二元组 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  const latin = lower.match(LATIN_WORD);
  if (latin) tokens.push(...latin);

  const cjk = lower.match(CJK_CHAR);
  if (cjk) {
    tokens.push(...cjk);
    // 二元组：捕捉"排序""函数"等词级语义
    for (let i = 0; i < cjk.length - 1; i++) {
      tokens.push(cjk[i]! + cjk[i + 1]!);
    }
  }
  return tokens;
}

/** 关键词哈希 embedding：确定性、零依赖、离线 */
export function keywordEmbed(text: string, dim = DEFAULT_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = tokenize(text);
  for (const tok of tokens) {
    vec[hashToken(tok) % dim] += 1;
  }
  // L2 归一化（让余弦相似度只看方向）
  let norm = 0;
  for (const v of vec) norm += v * v;
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < dim; i++) vec[i]! *= inv;
  }
  return vec;
}

/** 默认 provider：关键词哈希。日后换 transformers.js 时改这里的返回即可 */
export const keywordEmbeddingProvider: EmbeddingProvider = {
  name: "keyword-hash",
  dim: DEFAULT_DIM,
  embed: async (text: string) => keywordEmbed(text, DEFAULT_DIM),
};

let activeProvider: EmbeddingProvider = keywordEmbeddingProvider;

/** 取当前激活的 embedding provider */
export function getEmbeddingProvider(): EmbeddingProvider {
  return activeProvider;
}

/** 替换 provider（测试 / 未来接 transformers.js 用） */
export function setEmbeddingProvider(p: EmbeddingProvider): void {
  activeProvider = p;
}
