//! spawn 本机 CLI（claude/codex）吃订阅额度。这是「平台能力」（spawn 子进程必须在 Rust），
//! 不是业务逻辑：模型路由 / 计费 / 解析仍全在 TS。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::Manager;
use tauri::State;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::process::{classify_spawn_error, kill_pid, CliErrorKind};
use crate::security::{
    extra_path_dirs, find_in_common_locations, find_in_path, is_executable_file,
};

/// 在跑的 CLI 子进程表（按前端传来的 sessionId 索引，存 pid 不存句柄——见 spawn_cli_stream
/// 里"为什么 spawn 后立刻 drop CommandChild"的注释）。
/// abort 时前端调 kill_cli(sessionId) → 按 pid 真正杀掉子进程，停止白耗订阅额度。
#[derive(Default)]
pub struct CliChildren(pub(crate) Mutex<HashMap<String, u32>>);

/// 流式回传给前端的事件（每行 stdout 一条，JSONL 由前端 cli-protocol 解析）
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub(crate) enum CliStreamEvent {
    Stdout { line: String },
    Stderr { line: String },
    Terminated { code: Option<i32> },
    Error { message: String, kind: CliErrorKind },
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

/// CLI 进程 per-event 静默超时（1.3 修复）：
/// 健康流几秒就有 stdout，60s 没事件 = 卡死（卡在交互式登录 / 死锁 / 后台挂起）。
/// 对齐 API 路径的 sse-chunk-timeout 思路：每收到事件重置计时器。
const CLI_EVENT_STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// CLI 调试日志（2026-07-07 加）：写在 app 数据目录下的纯文本文件，把每次 spawn 的
/// 启动参数 + 原始 stdout/stderr 逐行 + 终止/报错事件都记下来。
/// 目的：之前排查"卡住不知道死活"只能靠反复猜事件类型、拿用户真实额度试，这个日志让
/// 下次直接读文件看真实发生了什么，不用再猜，也不需要用户会用 devtools。
/// 单文件超过 5MB 时清空重开，避免长时间调试把磁盘占满。
fn cli_log_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("cli-debug.log"))
}

fn append_cli_log(app: &tauri::AppHandle, session_id: &str, line: &str) {
    use std::io::Write as _;
    let Some(path) = cli_log_path(app) else {
        return;
    };
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 5 * 1024 * 1024 {
            let _ = std::fs::remove_file(&path);
        }
    }
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "[{timestamp}] [{session_id}] {line}");
    }
}

/// Resolve a local CLI executable to an absolute path for the provider form.
/// Returning None is valid: the caller can leave the field blank and rely on PATH at runtime.
#[tauri::command]
pub fn resolve_cli_program(program: String) -> Option<String> {
    if program.contains('/') {
        let path = PathBuf::from(program);
        return is_executable_file(&path).then(|| path.to_string_lossy().to_string());
    }
    find_in_path(&program)
        .or_else(|| find_in_common_locations(&program))
        .map(|path| path.to_string_lossy().to_string())
}

/// `spawn_cli_stream` 的调用参数（`on_event` 除外——Channel 类型必须留在顶层参数，
/// 不能塞进这个结构体）。原来是 6 个独立函数参数（clippy too_many_arguments），打包成
/// 一个结构体——JS 侧 invoke 调用相应地把这些字段嵌到一个 `params` 键下
/// （见 `app/src/lib/llm/cli-engine.ts`）。
///
/// - `program`：可执行文件路径（绝对路径优先，避免 GUI app PATH 不含 nvm 找不到 claude）
/// - `args`：启动参数（由前端 cli-protocol::buildCliArgs 构造）
/// - `extra_env`：额外覆盖的环境变量（一般为空；受控 env 的污染过滤在本函数内做）
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnCliStreamParams {
    session_id: String,
    program: String,
    args: Vec<String>,
    extra_env: HashMap<String, String>,
    working_directory: Option<String>,
}

/// spawn 一个本机 CLI，流式把 stdout/stderr 按行推给前端。`on_event` 是流式回传通道。
#[tauri::command]
pub async fn spawn_cli_stream(
    app: tauri::AppHandle,
    children: State<'_, CliChildren>,
    params: SpawnCliStreamParams,
    on_event: Channel<CliStreamEvent>,
) -> Result<(), String> {
    let SpawnCliStreamParams {
        session_id,
        program,
        args,
        extra_env,
        working_directory,
    } = params;

    // 受控环境：继承父环境，删掉污染变量，再叠加前端 override
    let mut env: HashMap<String, String> = std::env::vars()
        .filter(|(k, _)| !POLLUTING_ENV_PREFIXES.iter().any(|p| k.starts_with(p)))
        .collect();
    for (k, v) in extra_env {
        env.insert(k, v);
    }

    // 修复（2026-07-02）：把 nvm/homebrew 等常见 node 安装目录补进子进程 PATH，
    // 解决 GUI app 继承 PATH 过窄导致 claude/codex 内部 `env node` 找不到 node 的问题。
    let extra_dirs = extra_path_dirs();
    if !extra_dirs.is_empty() {
        let existing_path = env.get("PATH").cloned().unwrap_or_default();
        let mut all_dirs = extra_dirs;
        all_dirs.extend(std::env::split_paths(&existing_path));
        if let Ok(joined) = std::env::join_paths(&all_dirs) {
            env.insert("PATH".to_string(), joined.to_string_lossy().into_owned());
        }
    }

    append_cli_log(
        &app,
        &session_id,
        &format!(
            "SPAWN program={program} cwd={} args={args:?}",
            working_directory.as_deref().unwrap_or("(default)"),
        ),
    );

    let mut command = app
        .shell()
        .command(&program)
        .args(args)
        .env_clear()
        .envs(env);
    if let Some(cwd) = working_directory.filter(|p| !p.trim().is_empty()) {
        command = command.current_dir(cwd);
    }

    // 1.4 修复：spawn 失败时不直接返回 Err 让前端走 .catch 拿原始字符串，
    // 而是通过 Channel 发 kind=SpawnFailed Error 事件 + 正常 Ok，让前端在
    // channel.onmessage 里识别 kind 给出"未安装 CLI / 请先安装"友好文案。
    let (mut rx, child) = match command.spawn() {
        Ok(pair) => pair,
        Err(e) => {
            let msg = e.to_string();
            let kind = classify_spawn_error(&msg);
            append_cli_log(&app, &session_id, &format!("SPAWN_FAILED {msg}"));
            let _ = on_event.send(CliStreamEvent::Error { message: msg, kind });
            return Ok(());
        }
    };

    // 2026-07-05 修复：tauri-plugin-shell 无条件把子进程 stdin 设成管道（Stdio::piped()），
    // 且没有提供"只关 stdin、不杀进程"的 API。codex exec 的行为是：即使 prompt 已经用参数
    // 传了，只要 stdin 是管道状态，它也会先等着把 stdin 内容当"附加输入"读完（read 到 EOF）
    // 才会真正处理这一轮——我们从来不写任何东西，也从来没关过这根管道，于是 codex 就一直
    // 卡在这一步，直到被下面的 60s watchdog 杀掉，误报成"CLI 进程未产生任何事件"（实测复现）。
    //
    // 修法：拿到 pid 后立刻把 CommandChild 整个 drop 掉——它的 stdin_writer（os_pipe 的
    // PipeWriter）被 drop 时会关闭这一端的管道，子进程收到 EOF，不再傻等；child 内部的
    // Arc<SharedChild> 被 drop 不会杀死进程（shared_child crate 设计成允许句柄单独释放而不
    // 影响实际的 OS 进程和已经在跑的 stdout/stderr 读取任务）。真正杀进程改成按 pid 发信号
    // （kill_pid），不再依赖 CommandChild::kill()。
    let pid = child.pid();
    drop(child);
    if let Ok(mut map) = children.0.lock() {
        map.insert(session_id.clone(), pid);
    }

    // 1.3 修复：per-event 静默超时（参考 app/src/lib/llm/sse-chunk-timeout.ts 思路）。
    // tokio::select! 让 rx.recv() 和 sleep 赛跑——任何事件都重置计时器，
    // 60s 没事件 = CLI 进程卡死（卡在交互式登录 / 死锁 / 后台挂起），
    // 发 kind=Stalled Error + 主动 kill 子进程防白耗订阅额度。
    loop {
        let event = tokio::select! {
            event = rx.recv() => event,
            _ = tokio::time::sleep(CLI_EVENT_STALL_TIMEOUT) => {
                append_cli_log(
                    &app,
                    &session_id,
                    &format!("STALLED after {}s with no event", CLI_EVENT_STALL_TIMEOUT.as_secs()),
                );
                let _ = on_event.send(CliStreamEvent::Error {
                    message: format!(
                        "CLI 进程超过 {} 秒未产生任何事件，已自动终止",
                        CLI_EVENT_STALL_TIMEOUT.as_secs()
                    ),
                    kind: CliErrorKind::Stalled,
                });
                if let Ok(mut map) = children.0.lock() {
                    if let Some(pid) = map.remove(&session_id) {
                        let _ = kill_pid(pid);
                    }
                }
                return Ok(());
            }
        };

        let Some(event) = event else { break };

        let payload = match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
                append_cli_log(&app, &session_id, &format!("STDOUT {line}"));
                CliStreamEvent::Stdout { line }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
                append_cli_log(&app, &session_id, &format!("STDERR {line}"));
                CliStreamEvent::Stderr { line }
            }
            CommandEvent::Terminated(p) => {
                append_cli_log(&app, &session_id, &format!("TERMINATED code={:?}", p.code));
                CliStreamEvent::Terminated { code: p.code }
            }
            CommandEvent::Error(err) => {
                append_cli_log(&app, &session_id, &format!("EVENT_ERROR {err}"));
                CliStreamEvent::Error {
                    message: err,
                    kind: CliErrorKind::ExecutionFailed,
                }
            }
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
pub fn kill_cli(children: State<'_, CliChildren>, session_id: String) -> Result<bool, String> {
    let pid = children
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id);
    match pid {
        Some(pid) => {
            kill_pid(pid).map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}
