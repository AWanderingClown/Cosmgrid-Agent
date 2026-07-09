//! 系统密钥链读写——API key 必须 Rust：只有 Rust 侧能访问 OS keychain（macOS Keychain /
//! Windows Credential Manager / Linux Secret Service），前端没有对应能力，也不该有。

use keyring::Entry;

const API_KEY_SERVICE: &str = "com.cosmgrid.agent.api-key.v1";

fn api_key_entry(credential_id: &str) -> Result<Entry, String> {
    let id = credential_id.trim();
    if id.is_empty() {
        return Err("credential_id is required".to_string());
    }
    Entry::new(API_KEY_SERVICE, id).map_err(|e| format!("system credential store unavailable: {e}"))
}

#[tauri::command]
pub fn save_api_key(credential_id: String, api_key: String) -> Result<(), String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("api_key is required".to_string());
    }
    let entry = api_key_entry(&credential_id)?;
    entry
        .set_password(key)
        .map_err(|e| format!("failed to save API key in system credential store: {e}"))?;
    let verified = entry
        .get_password()
        .map_err(|e| format!("failed to verify API key in system credential store: {e}"))?;
    if verified == key {
        Ok(())
    } else {
        Err("failed to verify API key in system credential store".to_string())
    }
}

#[tauri::command]
pub fn get_api_key(credential_id: String) -> Result<Option<String>, String> {
    let entry = api_key_entry(&credential_id)?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!(
            "failed to read API key from system credential store: {e}"
        )),
    }
}

#[tauri::command]
pub fn delete_api_key(credential_id: String) -> Result<(), String> {
    let entry = api_key_entry(&credential_id)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!(
            "failed to delete API key from system credential store: {e}"
        )),
    }
}
