// Cosmgrid-Agent Tauri 2 入口
// v0.3：注册 tauri-plugin-sql + tauri-plugin-store，不写 Rust 业务逻辑
// v0.7：新增 tauri-plugin-shell + spawn_cli_stream 命令——spawn 本机 CLI（claude/codex）
//        吃订阅额度。这是「平台能力」（spawn 子进程必须在 Rust），不是业务逻辑：
//        模型路由 / 计费 / 解析仍全在 TS。

use std::collections::HashMap;
use tauri::ipc::Channel;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

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

/// spawn 一个本机 CLI，流式把 stdout/stderr 按行推给前端。
///
/// - `program`：可执行文件路径（绝对路径优先，避免 GUI app PATH 不含 nvm 找不到 claude）
/// - `args`：启动参数（由前端 cli-protocol::buildCliArgs 构造）
/// - `extra_env`：额外覆盖的环境变量（一般为空；受控 env 的污染过滤在本函数内做）
/// - `on_event`：流式回传通道
#[tauri::command]
async fn spawn_cli_stream(
    app: tauri::AppHandle,
    program: String,
    args: Vec<String>,
    extra_env: HashMap<String, String>,
    on_event: Channel<CliStreamEvent>,
) -> Result<(), String> {
    // 受控环境：继承父环境，删掉污染变量，再叠加前端 override
    let mut env: HashMap<String, String> = std::env::vars()
        .filter(|(k, _)| !POLLUTING_ENV_PREFIXES.iter().any(|p| k.starts_with(p)))
        .collect();
    for (k, v) in extra_env {
        env.insert(k, v);
    }

    let command = app
        .shell()
        .command(&program)
        .args(args)
        .env_clear()
        .envs(env);

    let (mut rx, _child) = command.spawn().map_err(|e| e.to_string())?;

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

    Ok(())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![spawn_cli_stream, run_shell_command])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
