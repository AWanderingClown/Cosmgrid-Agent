//! `#[tauri::command]` 入口层，按领域拆成子模块。每个 command 函数尽量薄——真正的进程生命周期
//! 逻辑在 `crate::process`，安全校验在 `crate::security`。目前没有 command 出现足够复杂的业务
//! 分支需要再拆 `services/` 子层；等出现时再加。

pub mod cli;
pub mod fetch;
pub mod keychain;
pub mod menu;
pub mod rpc;
pub mod shell;
