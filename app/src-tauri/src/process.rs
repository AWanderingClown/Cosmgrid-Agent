//! 子进程生命周期基础设施：跨平台按 pid/进程组杀进程、空闲超时执行器、spawn 错误分类。
//! 不含任何 `#[tauri::command]`——纯基础设施，被 `commands::cli` / `commands::rpc` / `commands::shell` 复用。

use std::time::Duration;
use tauri_plugin_shell::process::CommandEvent;

/// 按 pid 杀掉一个进程（跨平台）。tauri-plugin-shell 的 CommandChild::kill() 本可以做到，
/// 但我们故意不在 map 里存 CommandChild（见 `commands::cli::spawn_cli_stream` 注释），
/// 所以自己按 pid 发信号。
pub(crate) fn kill_pid(pid: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()?;
    }
    #[cfg(windows)]
    {
        std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .status()?;
    }
    Ok(())
}

/// RPC server may spawn descendants (notably npx -> node). Kill the process tree,
/// otherwise removing the parent handle leaves the actual MCP/LSP server alive.
pub(crate) fn kill_process_tree(pid: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-9", "--", &format!("-{pid}")])
            .status()?;
    }
    #[cfg(windows)]
    {
        std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .status()?;
    }
    Ok(())
}

/// CliStreamEvent::Error 的 kind 字段（1.4 修复）：
/// - spawn_failed：spawn 阶段失败（CLI 程序不存在 / 没装 / PATH 找不到），用户必须先装才能用
/// - execution_failed：CLI 跑起来后失败（进程退出码非 0 / stderr 报错），可尝试 fallback
/// - stalled：1.3 修复，per-event 静默超时，CLI 启动但不再产生任何事件
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CliErrorKind {
    SpawnFailed,
    ExecutionFailed,
    Stalled,
}

/// 1.4 修复：识别 spawn 阶段失败的 OS 错误特征，标记为 spawn_failed
/// 让前端能给用户"未安装 CLI / 请先安装"的引导，而不是通用重试。
pub(crate) fn classify_spawn_error(msg: &str) -> CliErrorKind {
    let lower = msg.to_lowercase();
    if lower.contains("no such file")
        || lower.contains("not found")
        || lower.contains("os error 2")
        || lower.contains("permission denied")
        || lower.contains("access is denied")
    {
        CliErrorKind::SpawnFailed
    } else {
        CliErrorKind::ExecutionFailed
    }
}

/// 一次性运行一条命令的结果（shell / git 共用）。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShellOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
}

/// 统一的"子进程 + 空闲超时"执行器：spawn 出来的子进程只要还在吐 stdout/stderr（或退出）就不会
/// 被杀，只有连续 idle_secs 秒完全静默才判定卡死、kill 掉并报错。run_shell_command 和几个内部
/// git 操作共用同一份逻辑——都是同一类风险（子进程可能因为读 stdin 卡住等交互输入而永久挂起）。
pub(crate) async fn run_with_idle_timeout(
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    child: tauri_plugin_shell::process::CommandChild,
    idle_secs: u64,
) -> Result<ShellOutput, String> {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut code = None;
    let idle = Duration::from_secs(idle_secs);

    loop {
        match tokio::time::timeout(idle, rx.recv()).await {
            Ok(Some(event)) => match event {
                CommandEvent::Terminated(payload) => {
                    code = payload.code;
                    break;
                }
                CommandEvent::Stdout(line) => {
                    stdout.extend(line);
                    stdout.push(b'\n');
                }
                CommandEvent::Stderr(line) => {
                    stderr.extend(line);
                    stderr.push(b'\n');
                }
                CommandEvent::Error(_) => {}
                _ => {}
            },
            // 通道自然关闭（进程确实退出了，只是 Terminated 事件先一步没接住）
            Ok(None) => break,
            // 连续 idle_secs 秒没有任何事件——真在干活的命令不会触发这条分支
            Err(_) => {
                let _ = child.kill();
                return Err(format!(
                    "命令连续 {idle_secs} 秒没有任何输出，判定卡死已强制终止（真在跑的构建/安装会持续有日志，不会被这个误杀；卡死常见于等交互输入，比如缺 -m 的 git commit）"
                ));
            }
        }
    }

    Ok(ShellOutput {
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        code,
    })
}
