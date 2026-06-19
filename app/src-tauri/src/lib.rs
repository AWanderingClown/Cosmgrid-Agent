// Cosmgrid-Agent Tauri 2 入口
// v0.3：注册 tauri-plugin-sql + tauri-plugin-store，不写 Rust 业务逻辑

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
