// API Key secure storage.
// New writes go to the operating system credential store via Tauri commands.
// The legacy plaintext store is read only for one-by-one migration.

import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";

const LEGACY_STORE_FILE = "cosmgrid-keys.json";
const PREFIX = "apiKey:";

// 修复（2026-07-02）：用户反馈每次切模型/发消息/新建对话都弹一次 macOS 钥匙串授权确认框，
// 要输入开机密码。根因是 getApiKey 之前完全不缓存——ChatPage.tsx 里每次发消息、每个
// fallback 候选、每个 debate 参与者都会重新调一次 invoke("get_api_key", ...)，真打一次
// Keychain。macOS 的"始终允许"授权是跟应用的代码签名绑定的，dev 构建每次重新签名签名会
// 变，导致这个授权记不住、每次都要重新问。真正的根治需要稳定的发行签名（打包/分发层面的
// 事，不是这里能解决的），但不管签名稳不稳，"同一次运行的应用里，同一个credential的key
// 反复问钥匙串"本身就是不必要的重复调用——加一层内存缓存，同一次应用运行内一个
// credential 只真正问一次钥匙串，后续直接读内存。
const apiKeyMemoryCache = new Map<string, string>();

let legacyStore: Store | null = null;

async function getLegacyStore(): Promise<Store> {
  if (!legacyStore) {
    legacyStore = await Store.load(LEGACY_STORE_FILE);
  }
  return legacyStore;
}

async function getLegacyApiKey(credentialId: string): Promise<string | null> {
  const store = await getLegacyStore();
  const val = await store.get<string>(`${PREFIX}${credentialId}`);
  return typeof val === "string" && val.length > 0 ? val : null;
}

async function deleteLegacyApiKey(credentialId: string): Promise<void> {
  const store = await getLegacyStore();
  await store.delete(`${PREFIX}${credentialId}`);
  await store.save();
}

async function saveApiKeyToKeychain(credentialId: string, apiKey: string): Promise<void> {
  await invoke("save_api_key", { credentialId, apiKey });
}

async function getApiKeyFromKeychain(credentialId: string): Promise<string | null> {
  return await invoke<string | null>("get_api_key", { credentialId });
}

async function deleteApiKeyFromKeychain(credentialId: string): Promise<void> {
  await invoke("delete_api_key", { credentialId });
}

export async function saveApiKey(credentialId: string, apiKey: string): Promise<void> {
  await saveApiKeyToKeychain(credentialId, apiKey);
  await deleteLegacyApiKey(credentialId).catch(() => {});
  apiKeyMemoryCache.set(credentialId, apiKey);
}

export async function getApiKey(credentialId: string): Promise<string | null> {
  const cached = apiKeyMemoryCache.get(credentialId);
  if (cached !== undefined) return cached;

  const keychainValue = await getApiKeyFromKeychain(credentialId);
  if (keychainValue) {
    apiKeyMemoryCache.set(credentialId, keychainValue);
    return keychainValue;
  }

  const legacyValue = await getLegacyApiKey(credentialId).catch(() => null);
  if (!legacyValue) return null;

  await saveApiKeyToKeychain(credentialId, legacyValue);
  await deleteLegacyApiKey(credentialId).catch(() => {});
  apiKeyMemoryCache.set(credentialId, legacyValue);
  return legacyValue;
}

export async function deleteApiKey(credentialId: string): Promise<void> {
  await deleteApiKeyFromKeychain(credentialId);
  await deleteLegacyApiKey(credentialId).catch(() => {});
  apiKeyMemoryCache.delete(credentialId);
}

/** 仅供测试用：清空内存缓存，避免跨用例污染（生产代码不要调这个）。 */
export function __clearApiKeyMemoryCacheForTests(): void {
  apiKeyMemoryCache.clear();
}

export interface LegacyApiKeyMigrationReport {
  migrated: number;
  skipped: number;
  failed: number;
}

export async function migrateLegacyApiKeys(validCredentialIds: string[]): Promise<LegacyApiKeyMigrationReport> {
  const validIds = new Set(validCredentialIds);
  const store = await getLegacyStore();
  const keys = await store.keys();
  const report: LegacyApiKeyMigrationReport = { migrated: 0, skipped: 0, failed: 0 };

  for (const key of keys) {
    if (!key.startsWith(PREFIX)) continue;
    const credentialId = key.slice(PREFIX.length);
    if (!validIds.has(credentialId)) {
      report.skipped += 1;
      continue;
    }

    const apiKey = await store.get<string>(key);
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      report.skipped += 1;
      continue;
    }

    try {
      await saveApiKeyToKeychain(credentialId, apiKey);
      await store.delete(key);
      report.migrated += 1;
    } catch {
      report.failed += 1;
    }
  }

  if (report.migrated > 0) {
    await store.save();
  }
  return report;
}
