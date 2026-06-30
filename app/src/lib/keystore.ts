// API Key secure storage.
// New writes go to the operating system credential store via Tauri commands.
// The legacy plaintext store is read only for one-by-one migration.

import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";

const LEGACY_STORE_FILE = "cosmgrid-keys.json";
const PREFIX = "apiKey:";

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
}

export async function getApiKey(credentialId: string): Promise<string | null> {
  const keychainValue = await getApiKeyFromKeychain(credentialId);
  if (keychainValue) return keychainValue;

  const legacyValue = await getLegacyApiKey(credentialId).catch(() => null);
  if (!legacyValue) return null;

  await saveApiKeyToKeychain(credentialId, legacyValue);
  await deleteLegacyApiKey(credentialId).catch(() => {});
  return legacyValue;
}

export async function deleteApiKey(credentialId: string): Promise<void> {
  await deleteApiKeyFromKeychain(credentialId);
  await deleteLegacyApiKey(credentialId).catch(() => {});
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
