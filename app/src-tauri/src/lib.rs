// Cosmgrid-Agent Tauri 2 入口
// v0.3：注册 tauri-plugin-sql + tauri-plugin-store，不写 Rust 业务逻辑
// v0.7：新增 tauri-plugin-shell + spawn_cli_stream 命令——spawn 本机 CLI（claude/codex）
//        吃订阅额度。这是「平台能力」（spawn 子进程必须在 Rust），不是业务逻辑：
//        模型路由 / 计费 / 解析仍全在 TS。

use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use keyring::Entry;
use tauri::ipc::Channel;
use tauri::Manager;
use tauri::State;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// 在跑的 CLI 子进程句柄表（按前端传来的 sessionId 索引）。
/// abort 时前端调 kill_cli(sessionId) → 真正 SIGKILL 子进程，停止白耗订阅额度。
#[derive(Default)]
struct CliChildren(Mutex<HashMap<String, CommandChild>>);

/// 流式回传给前端的事件（每行 stdout 一条，JSONL 由前端 cli-protocol 解析）
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
enum CliStreamEvent {
    Stdout { line: String },
    Stderr { line: String },
    Terminated { code: Option<i32> },
    Error { message: String },
}

/// cc switch / Claude Code 会往环境里注入这些前缀的变量，会让 spawn 出来的 claude
/// 改走第三方路由（如 MiniMax）或误判嵌套会话。spawn 前从子进程环境里抹掉。
/// 注意：与前端 cli-protocol.ts 的 POLLUTING_ENV_PREFIXES 保持一致。
const POLLUTING_ENV_PREFIXES: [&str; 4] = [
    "ANTHROPIC_",
    "CLAUDECODE",
    "CLAUDE_CODE_",
    "CLAUDE_AGENT_SDK_",
];

const API_KEY_SERVICE: &str = "com.cosmgrid.agent.api-key.v1";

fn api_key_entry(credential_id: &str) -> Result<Entry, String> {
    let id = credential_id.trim();
    if id.is_empty() {
        return Err("credential_id is required".to_string());
    }
    Entry::new(API_KEY_SERVICE, id).map_err(|e| format!("system credential store unavailable: {e}"))
}

#[tauri::command]
fn save_api_key(credential_id: String, api_key: String) -> Result<(), String> {
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
fn get_api_key(credential_id: String) -> Result<Option<String>, String> {
    let entry = api_key_entry(&credential_id)?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("failed to read API key from system credential store: {e}")),
    }
}

#[tauri::command]
fn delete_api_key(credential_id: String) -> Result<(), String> {
    let entry = api_key_entry(&credential_id)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("failed to delete API key from system credential store: {e}")),
    }
}

fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn find_in_path(program: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    env::split_paths(&path_var)
        .map(|dir| dir.join(program))
        .find(|candidate| is_executable_file(candidate))
}

fn find_in_common_locations(program: &str) -> Option<PathBuf> {
    let home = env::var_os("HOME").map(PathBuf::from);
    let mut candidates = vec![
        PathBuf::from(format!("/opt/homebrew/bin/{program}")),
        PathBuf::from(format!("/usr/local/bin/{program}")),
        PathBuf::from(format!("/usr/bin/{program}")),
        PathBuf::from(format!("/bin/{program}")),
    ];

    if let Some(home_dir) = home {
        candidates.push(home_dir.join(format!(".local/bin/{program}")));
        let nvm_versions = home_dir.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(nvm_versions) {
            let mut node_bins: Vec<PathBuf> = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path().join(format!("bin/{program}")))
                .collect();
            node_bins.sort();
            node_bins.reverse();
            candidates.extend(node_bins);
        }
    }

    candidates
        .into_iter()
        .find(|candidate| is_executable_file(candidate))
}

/// Resolve a local CLI executable to an absolute path for the provider form.
/// Returning None is valid: the caller can leave the field blank and rely on PATH at runtime.
#[tauri::command]
fn resolve_cli_program(program: String) -> Option<String> {
    if program.contains('/') {
        let path = PathBuf::from(program);
        return is_executable_file(&path).then(|| path.to_string_lossy().to_string());
    }
    find_in_path(&program)
        .or_else(|| find_in_common_locations(&program))
        .map(|path| path.to_string_lossy().to_string())
}

/// spawn 一个本机 CLI，流式把 stdout/stderr 按行推给前端。
///
/// - `program`：可执行文件路径（绝对路径优先，避免 GUI app PATH 不含 nvm 找不到 claude）
/// - `args`：启动参数（由前端 cli-protocol::buildCliArgs 构造）
/// - `extra_env`：额外覆盖的环境变量（一般为空；受控 env 的污染过滤在本函数内做）
/// - `on_event`：流式回传通道
#[tauri::command]
async fn spawn_cli_stream(
    app: tauri::AppHandle,
    children: State<'_, CliChildren>,
    session_id: String,
    program: String,
    args: Vec<String>,
    extra_env: HashMap<String, String>,
    working_directory: Option<String>,
    on_event: Channel<CliStreamEvent>,
) -> Result<(), String> {
    // 受控环境：继承父环境，删掉污染变量，再叠加前端 override
    let mut env: HashMap<String, String> = std::env::vars()
        .filter(|(k, _)| !POLLUTING_ENV_PREFIXES.iter().any(|p| k.starts_with(p)))
        .collect();
    for (k, v) in extra_env {
        env.insert(k, v);
    }

    let mut command = app
        .shell()
        .command(&program)
        .args(args)
        .env_clear()
        .envs(env);
    if let Some(cwd) = working_directory.filter(|p| !p.trim().is_empty()) {
        command = command.current_dir(cwd);
    }

    let (mut rx, child) = command.spawn().map_err(|e| e.to_string())?;

    // 存句柄，供 kill_cli 按 sessionId 杀进程。同一 sessionId 重复 spawn 时旧句柄被覆盖。
    if let Ok(mut map) = children.0.lock() {
        map.insert(session_id.clone(), child);
    }

    while let Some(event) = rx.recv().await {
        let payload = match event {
            CommandEvent::Stdout(bytes) => CliStreamEvent::Stdout {
                line: String::from_utf8_lossy(&bytes).trim_end().to_string(),
            },
            CommandEvent::Stderr(bytes) => CliStreamEvent::Stderr {
                line: String::from_utf8_lossy(&bytes).trim_end().to_string(),
            },
            CommandEvent::Terminated(p) => CliStreamEvent::Terminated { code: p.code },
            CommandEvent::Error(err) => CliStreamEvent::Error { message: err },
            _ => continue,
        };
        // 通道关闭（前端 abort）→ 停止读取
        if on_event.send(payload).is_err() {
            break;
        }
    }

    // 进程已自然结束（或通道断开）→ 清掉句柄，避免 map 泄漏。
    if let Ok(mut map) = children.0.lock() {
        map.remove(&session_id);
    }

    Ok(())
}

/// 杀掉指定 sessionId 的 CLI 子进程（前端 abort 时调用）。
/// 返回 true=找到并杀掉；false=没有这个 session（已自然结束或从未存在）。
#[tauri::command]
fn kill_cli(children: State<'_, CliChildren>, session_id: String) -> Result<bool, String> {
    let child = children
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id);
    match child {
        Some(c) => {
            c.kill().map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// 一次性运行一条 shell 命令（在指定工作目录），捕获 stdout/stderr/exit code。
/// v0.7 阶段4b：bash 工具用。**安全前置在 TS 侧**（command-safety 白名单 + 危险拦截 + 用户确认），
/// 本函数只负责执行已批准的命令；用 `sh -c` 以支持白名单命令的参数与管道。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellOutput {
    stdout: String,
    stderr: String,
    code: Option<i32>,
}

#[tauri::command]
async fn run_shell_command(
    app: tauri::AppHandle,
    command: String,
    cwd: String,
) -> Result<ShellOutput, String> {
    let output = app
        .shell()
        .command("sh")
        .args(["-c", &command])
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    Ok(ShellOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        code: output.status.code(),
    })
}

/// 给单个文件做一次 git commit（AI 写操作后的回滚兜底）。
/// v0.7 阶段4b 增强：路径与消息作为**独立参数**传给 git（不经 sh -c），杜绝 shell 注入。
/// 非 git 仓库 / git 失败 → 返回 false（不报错，调用方据此标记 reversible）。
#[tauri::command]
async fn git_commit_file(
    app: tauri::AppHandle,
    workspace: String,
    rel_path: String,
    message: String,
) -> Result<bool, String> {
    let add = app
        .shell()
        .command("git")
        .args(["add", "--", &rel_path])
        .current_dir(&workspace)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !add.status.success() {
        return Ok(false); // 非 git 仓库等
    }

    let commit = app
        .shell()
        .command("git")
        .args(["commit", "-m", &message, "--", &rel_path])
        .current_dir(&workspace)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    Ok(commit.status.success())
}

/// 只读 git 查询（status / diff / log）：AI 改完代码后能看到自己改了啥。
/// v0.7 增强-2：参数作为**独立 Vec 传给 git**（不经 sh -c），杜绝 shell 注入；
/// **子命令白名单 + 参数构造在 TS 侧**（git-read-tool 只放行 status/diff/log，绝不传写命令）。
/// 本函数只执行已构造好的只读 git 命令，捕获 stdout/stderr/exit code。
#[tauri::command]
async fn git_read(
    app: tauri::AppHandle,
    workspace: String,
    args: Vec<String>,
) -> Result<ShellOutput, String> {
    let output = app
        .shell()
        .command("git")
        .args(args)
        .current_dir(workspace)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    Ok(ShellOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        code: output.status.code(),
    })
}

/// 按语言构建 macOS 原生菜单（中/英）。原生菜单不归前端 i18n 管，必须在 Rust 侧建。
/// 只在 macOS 编译/生效；其它平台保留 Tauri 默认菜单。
#[cfg(target_os = "macos")]
fn build_localized_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    lang: &str,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{AboutMetadata, MenuBuilder, PredefinedMenuItem, SubmenuBuilder};

    let zh = lang.starts_with("zh");
    // 小助手：按语言二选一
    let l = |z: &'static str, e: &'static str| if zh { z } else { e };

    let app_menu = SubmenuBuilder::new(app, "Cosmgrid Agent")
        .item(&PredefinedMenuItem::about(
            app,
            Some(l("关于 Cosmgrid Agent", "About Cosmgrid Agent")),
            Some(AboutMetadata::default()),
        )?)
        .separator()
        .item(&PredefinedMenuItem::services(app, Some(l("服务", "Services")))?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some(l("隐藏 Cosmgrid Agent", "Hide Cosmgrid Agent")))?)
        .item(&PredefinedMenuItem::hide_others(app, Some(l("隐藏其他", "Hide Others")))?)
        .item(&PredefinedMenuItem::show_all(app, Some(l("全部显示", "Show All")))?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some(l("退出 Cosmgrid Agent", "Quit Cosmgrid Agent")))?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, l("编辑", "Edit"))
        .item(&PredefinedMenuItem::undo(app, Some(l("撤销", "Undo")))?)
        .item(&PredefinedMenuItem::redo(app, Some(l("重做", "Redo")))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some(l("剪切", "Cut")))?)
        .item(&PredefinedMenuItem::copy(app, Some(l("复制", "Copy")))?)
        .item(&PredefinedMenuItem::paste(app, Some(l("粘贴", "Paste")))?)
        .item(&PredefinedMenuItem::select_all(app, Some(l("全选", "Select All")))?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, l("视图", "View"))
        .item(&PredefinedMenuItem::fullscreen(app, Some(l("切换全屏", "Toggle Full Screen")))?)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, l("窗口", "Window"))
        .item(&PredefinedMenuItem::minimize(app, Some(l("最小化", "Minimize")))?)
        .item(&PredefinedMenuItem::maximize(app, Some(l("缩放", "Zoom")))?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, Some(l("关闭窗口", "Close Window")))?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &view_menu, &window_menu])
        .build()
}

/// 前端在 i18n 初始化和切换语言时调用，按 app 选定语言重建原生菜单。
/// 非 macOS 为 no-op（保留默认菜单）。
#[tauri::command]
fn set_menu_language(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let menu = build_localized_menu(&app, &lang).map_err(|e| e.to_string())?;
        app.set_menu(menu).map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, &lang); // 避免未使用告警
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例保护：重复启动（Dock 图标重复点 / 崩溃残留进程 / Finder 重复双击）会导致
        // 两个进程同时抢占同一个 SQLite 文件，触发数据库打开失败或写入静默失败（"新对话"点了没反应）。
        // 第二个实例启动时转发事件给已在跑的实例并直接退出，不新建进程。必须是第一个注册的插件。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(CliChildren::default())
        .setup(|_app| {
            // 设初始原生菜单（macOS）。默认 zh，前端 i18n 就绪后会按真实语言重设。
            #[cfg(target_os = "macos")]
            {
                let menu = build_localized_menu(_app.handle(), "zh-CN")?;
                _app.set_menu(menu)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_api_key,
            get_api_key,
            delete_api_key,
            spawn_cli_stream,
            kill_cli,
            resolve_cli_program,
            run_shell_command,
            git_commit_file,
            git_read,
            set_menu_language
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
