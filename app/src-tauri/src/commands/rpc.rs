//! LSP / MCP stdio 这类长期 JSON-RPC 子进程管理。不同于 `commands::cli`，这里必须保留 stdin，
//! 因为前端会持续写请求，不能像 spawn_cli_stream 那样 spawn 后立刻 drop child。

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use tauri::Emitter;
use tauri::Manager;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;

use crate::process::kill_process_tree;
use crate::security::{extra_path_dirs, rpc_base_env};

struct RpcChild {
    pid: u32,
    stdin: Arc<tokio::sync::Mutex<ChildStdin>>,
}

/// LSP / MCP stdio 这类长期 JSON-RPC 子进程表。
#[derive(Default)]
pub struct RpcChildren(Mutex<HashMap<String, RpcChild>>);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
enum RpcProcessEvent {
    Message {
        session_id: String,
        message: String,
    },
    Stderr {
        session_id: String,
        line: String,
    },
    Terminated {
        session_id: String,
        code: Option<i32>,
    },
    Error {
        session_id: String,
        message: String,
    },
}

fn emit_rpc_event(app: &tauri::AppHandle, event: RpcProcessEvent) {
    let _ = app.emit("rpc-process-event", event);
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_content_length(header: &[u8]) -> Option<usize> {
    let text = String::from_utf8_lossy(header);
    text.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.trim().eq_ignore_ascii_case("content-length") {
            value.trim().parse::<usize>().ok()
        } else {
            None
        }
    })
}

async fn read_rpc_content_length_stdout(
    app: tauri::AppHandle,
    session_id: String,
    stdout: tokio::process::ChildStdout,
) {
    let mut reader = BufReader::new(stdout);
    let mut chunk = [0u8; 4096];
    let mut buffer: Vec<u8> = Vec::new();

    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                buffer.extend_from_slice(&chunk[..n]);
                while let Some(header_end) = find_header_end(&buffer) {
                    let Some(content_len) = parse_content_length(&buffer[..header_end]) else {
                        emit_rpc_event(
                            &app,
                            RpcProcessEvent::Error {
                                session_id: session_id.clone(),
                                message: "RPC content-length frame missing Content-Length header"
                                    .to_string(),
                            },
                        );
                        buffer.clear();
                        break;
                    };
                    let body_start = header_end + 4;
                    let body_end = body_start + content_len;
                    if buffer.len() < body_end {
                        break;
                    }
                    let body = String::from_utf8_lossy(&buffer[body_start..body_end]).into_owned();
                    emit_rpc_event(
                        &app,
                        RpcProcessEvent::Message {
                            session_id: session_id.clone(),
                            message: body,
                        },
                    );
                    buffer.drain(..body_end);
                }
            }
            Err(err) => {
                emit_rpc_event(
                    &app,
                    RpcProcessEvent::Error {
                        session_id,
                        message: format!("failed reading RPC stdout: {err}"),
                    },
                );
                break;
            }
        }
    }
}

async fn read_rpc_newline_stdout(
    app: tauri::AppHandle,
    session_id: String,
    stdout: tokio::process::ChildStdout,
) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if !line.trim().is_empty() {
                    emit_rpc_event(
                        &app,
                        RpcProcessEvent::Message {
                            session_id: session_id.clone(),
                            message: line,
                        },
                    );
                }
            }
            Ok(None) => break,
            Err(err) => {
                emit_rpc_event(
                    &app,
                    RpcProcessEvent::Error {
                        session_id,
                        message: format!("failed reading RPC stdout: {err}"),
                    },
                );
                break;
            }
        }
    }
}

async fn read_rpc_stderr(
    app: tauri::AppHandle,
    session_id: String,
    stderr: tokio::process::ChildStderr,
) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if !line.trim().is_empty() {
            emit_rpc_event(
                &app,
                RpcProcessEvent::Stderr {
                    session_id: session_id.clone(),
                    line,
                },
            );
        }
    }
}

/// `spawn_rpc_process` 的调用参数。原来是 7 个独立函数参数（clippy too_many_arguments），
/// 打包成一个结构体——JS 侧 invoke 调用相应地把这些字段嵌到一个 `params` 键下
/// （见 `app/src/lib/rpc/tauri-transport.ts`）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRpcProcessParams {
    session_id: String,
    program: String,
    args: Vec<String>,
    extra_env: HashMap<String, String>,
    working_directory: Option<String>,
    framing: String,
}

#[tauri::command]
pub async fn spawn_rpc_process(
    app: tauri::AppHandle,
    children: State<'_, RpcChildren>,
    params: SpawnRpcProcessParams,
) -> Result<(), String> {
    let SpawnRpcProcessParams {
        session_id,
        program,
        args,
        extra_env,
        working_directory,
        framing,
    } = params;

    if session_id.trim().is_empty() {
        return Err("session_id is required".to_string());
    }
    if program.trim().is_empty() {
        return Err("program is required".to_string());
    }
    if let Ok(map) = children.0.lock() {
        if map.contains_key(&session_id) {
            return Err(format!("RPC session already exists: {session_id}"));
        }
    }

    let mut env = rpc_base_env(std::env::vars());
    for (k, v) in extra_env {
        env.insert(k, v);
    }
    let extra_dirs = extra_path_dirs();
    if !extra_dirs.is_empty() {
        let existing_path = env.get("PATH").cloned().unwrap_or_default();
        let mut all_dirs = extra_dirs;
        all_dirs.extend(std::env::split_paths(&existing_path));
        if let Ok(joined) = std::env::join_paths(&all_dirs) {
            env.insert("PATH".to_string(), joined.to_string_lossy().into_owned());
        }
    }

    let mut command = tokio::process::Command::new(&program);
    command
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    if let Some(cwd) = working_directory.filter(|p| !p.trim().is_empty()) {
        command.current_dir(cwd);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to spawn RPC process: {e}"))?;
    let pid = child
        .id()
        .ok_or_else(|| "failed to get RPC process pid".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open RPC stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to open RPC stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to open RPC stderr".to_string())?;
    let stdin = Arc::new(tokio::sync::Mutex::new(stdin));

    children.0.lock().map_err(|e| e.to_string())?.insert(
        session_id.clone(),
        RpcChild {
            pid,
            stdin: Arc::clone(&stdin),
        },
    );

    let stdout_app = app.clone();
    let stdout_session = session_id.clone();
    match framing.as_str() {
        "content-length" => {
            tauri::async_runtime::spawn(read_rpc_content_length_stdout(
                stdout_app,
                stdout_session,
                stdout,
            ));
        }
        "newline" => {
            tauri::async_runtime::spawn(read_rpc_newline_stdout(
                stdout_app,
                stdout_session,
                stdout,
            ));
        }
        other => {
            children
                .0
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&session_id);
            let _ = kill_process_tree(pid);
            return Err(format!("unsupported RPC framing: {other}"));
        }
    }
    tauri::async_runtime::spawn(read_rpc_stderr(app.clone(), session_id.clone(), stderr));

    let wait_app = app.clone();
    let wait_session = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let code = child.wait().await.ok().and_then(|status| status.code());
        let rpc_children = wait_app.state::<RpcChildren>();
        if let Ok(mut map) = rpc_children.0.lock() {
            map.remove(&wait_session);
        }
        emit_rpc_event(
            &wait_app,
            RpcProcessEvent::Terminated {
                session_id: wait_session,
                code,
            },
        );
    });

    Ok(())
}

/// 2026-07-15 review 修复：单次 `write_rpc_stdin` 的超时上限。LSP/MCP 子进程写请求
/// 正常情况下毫秒级完成；给够余量应对子进程短暂繁忙，但不能没有上限。
const RPC_STDIN_WRITE_TIMEOUT_SECS: u64 = 10;

/// `kill_rpc_process` 命令和 `write_rpc_stdin` 超时兜底共用的"移出表 + 杀进程树"逻辑，
/// 避免两处实现分叉。
fn kill_rpc_session(children: &RpcChildren, session_id: &str) -> Result<bool, String> {
    let child = children
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .remove(session_id);
    match child {
        Some(child) => {
            kill_process_tree(child.pid).map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// 2026-07-15 review 修复：原实现 `writer.write_all(...).await` 没有任何超时包裹——
/// 如果子进程（LSP server 索引大项目时 CPU 繁忙、或已经死锁但还没退出）暂停读取 stdin，
/// OS 管道缓冲区写满后 `write_all` 会永久 pending，且此时它持有 `stdin` 这把 session 内
/// 唯一的 `tokio::sync::Mutex` 锁——后续这个 session 的所有 `write_rpc_stdin` 调用都会在
/// `stdin.lock().await` 上排队，永久收不到响应，直到进程被外部 kill。
///
/// 把「拿锁 + 写 + flush」整段包进 `tokio::time::timeout`：超时后 `timeout()` 会 drop 掉
/// 这个 future（连带释放持有的 `MutexGuard`），后续调用不会被这次卡死永久拖住。
///
/// 复检发现的遗漏（2026-07-15 二次修复）：`write_all` 不是原子操作，超时完全可能发生在
/// payload 已经部分写进 OS 管道之后——这个 session 的 stdin 流从这一刻起处于未知的半条
/// 消息状态，如果只返回错误、不处理这个 session，下一次 `write_rpc_stdin` 会把新 payload
/// 直接接在这段脏数据后面，让子进程收到的整条 stdin 流永久错位（LSP 的 Content-Length
/// framing 下会连累后续所有消息解析失败）。所以超时后不能只报错，必须主动杀掉这个 session
/// （复用 `kill_rpc_session`，跟 `kill_rpc_process` 命令共用逻辑），让它不能再被写——调用方
/// 后续对同一 session_id 的调用会快速拿到"RPC session not found"而不是继续复用一条脏流。
#[tauri::command]
pub async fn write_rpc_stdin(
    children: State<'_, RpcChildren>,
    session_id: String,
    payload: String,
) -> Result<(), String> {
    let stdin = {
        let map = children.0.lock().map_err(|e| e.to_string())?;
        map.get(&session_id)
            .map(|child| Arc::clone(&child.stdin))
            .ok_or_else(|| format!("RPC session not found: {session_id}"))?
    };
    let write_fut = async {
        let mut writer = stdin.lock().await;
        writer
            .write_all(payload.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        writer.flush().await.map_err(|e| e.to_string())
    };
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(RPC_STDIN_WRITE_TIMEOUT_SECS),
        write_fut,
    )
    .await;
    match result {
        Ok(inner) => inner,
        Err(_) => {
            // 超时：stdin 流可能已经写脏，这个 session 不能再被信任继续用，直接杀掉。
            // kill 本身失败（比如进程已经自己退出）不影响把错误报给调用方。
            let _ = kill_rpc_session(&children, &session_id);
            Err(format!(
                "write_rpc_stdin timed out after {RPC_STDIN_WRITE_TIMEOUT_SECS}s (session {session_id})：子进程可能已卡死，stdin 流可能已写脏，session 已自动终止，请重建会话"
            ))
        }
    }
}

#[tauri::command]
pub fn kill_rpc_process(
    children: State<'_, RpcChildren>,
    session_id: String,
) -> Result<bool, String> {
    kill_rpc_session(&children, &session_id)
}

#[cfg(test)]
mod tests {
    use super::{find_header_end, parse_content_length};

    #[test]
    fn parses_case_insensitive_content_length() {
        assert_eq!(
            parse_content_length(b"content-length: 27\r\nContent-Type: application/json"),
            Some(27)
        );
    }

    #[test]
    fn rejects_missing_or_invalid_content_length() {
        assert_eq!(
            parse_content_length(b"Content-Type: application/json"),
            None
        );
        assert_eq!(parse_content_length(b"Content-Length: nope"), None);
    }

    #[test]
    fn finds_only_complete_lsp_header_separator() {
        assert_eq!(find_header_end(b"Content-Length: 2\r\n\r\n{}"), Some(17));
        assert_eq!(find_header_end(b"Content-Length: 2\r\n"), None);
    }
}
