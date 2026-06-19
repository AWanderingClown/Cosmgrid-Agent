// API Key 安全存储（替代 DB 明文 apiKeyEncrypted 字段）
// 用 @tauri-apps/plugin-store 存 JSON 文件（不进 SQLite，不入 DB 明文）

import { Store } from "@tauri-apps/plugin-store";

let _store: Store | null = null;

async function getStore(): Promise<Store> {
  if (!_store) {
    _store = await Store.load("cosmgrid-keys.json");
  }
  return _store;
}

const PREFIX = "apiKey:";

export async function saveApiKey(credentialId: string, apiKey: string): Promise<void> {
  const store = await getStore();
  await store.set(`${PREFIX}${credentialId}`, apiKey);
  await store.save();
}

export async function getApiKey(credentialId: string): Promise<string | null> {
  const store = await getStore();
  const val = await store.get<string>(`${PREFIX}${credentialId}`);
  return val !== undefined ? val : null;
}

export async function deleteApiKey(credentialId: string): Promise<void> {
  const store = await getStore();
  await store.delete(`${PREFIX}${credentialId}`);
  await store.save();
}
