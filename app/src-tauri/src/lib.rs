// Cosmgrid-Agent Tauri 2 入口
// v0.3：注册 tauri-plugin-sql + tauri-plugin-store，不写 Rust 业务逻辑
// v0.7：新增 tauri-plugin-shell + spawn_cli_stream 命令——spawn 本机 CLI（claude/codex）
//        吃订阅额度。这是「平台能力」（spawn 子进程必须在 Rust），不是业务逻辑：
//        模型路由 / 计费 / 解析仍全在 TS。

use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use keyring::Entry;
use tauri::ipc::Channel;
use tauri::Manager;
use tauri::State;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// 在跑的 CLI 子进程表（按前端传来的 sessionId 索引，存 pid 不存句柄——见 spawn_cli_stream
/// 里"为什么 spawn 后立刻 drop CommandChild"的注释）。
/// abort 时前端调 kill_cli(sessionId) → 按 pid 真正杀掉子进程，停止白耗订阅额度。
#[derive(Default)]
struct CliChildren(Mutex<HashMap<String, u32>>);

/// fetch_url_rendered 的等待表（2026-07-05 新增）：requestId → oneshot 发送端。
/// 隐藏窗口里的页面加载完、脚本执行完之后，通过 report_rendered_page 命令把提取到的文本
/// 传回来，按 requestId 找到对应的 oneshot::Sender 塞进去，唤醒等在另一头的
/// fetch_url_rendered（它在 await 这个 receiver，见下方实现和注释）。
#[derive(Default)]
struct RenderChannels(Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>);

/// 按 pid 杀掉一个进程（跨平台）。tauri-plugin-shell 的 CommandChild::kill() 本可以做到，
/// 但我们故意不在 map 里存 CommandChild（见下方 spawn_cli_stream 注释），所以自己按 pid 发信号。
fn kill_pid(pid: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::process::Command::new("kill").args(["-9", &pid.to_string()]).status()?;
    }
    #[cfg(windows)]
    {
        std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
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
enum CliErrorKind {
    SpawnFailed,
    ExecutionFailed,
    Stalled,
}

/// 流式回传给前端的事件（每行 stdout 一条，JSONL 由前端 cli-protocol 解析）
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
enum CliStreamEvent {
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

const API_KEY_SERVICE: &str = "com.cosmgrid.agent.api-key.v1";

/// CLI 进程 per-event 静默超时（1.3 修复）：
/// 健康流几秒就有 stdout，60s 没事件 = 卡死（卡在交互式登录 / 死锁 / 后台挂起）。
/// 对齐 API 路径的 sse-chunk-timeout 思路：每收到事件重置计时器。
const CLI_EVENT_STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// 1.4 修复：识别 spawn 阶段失败的 OS 错误特征，标记为 spawn_failed
/// 让前端能给用户"未安装 CLI / 请先安装"的引导，而不是通用重试。
fn classify_spawn_error(msg: &str) -> CliErrorKind {
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

/// 2.2 修复补丁（2026-07-02）：符号链接 realpath 解析改走 Rust 侧。
/// TS 侧 `import("node:fs")` 在 Tauri WKWebView 渲染进程里不可用（既不是 Node.js 运行时
/// 也不是浏览器，`node:fs` 不会被打包也不会在运行时 resolve），之前的注入方式在生产
/// 构建里会静默失败（fallback 到 undefined），2.2 的符号链接逃逸防护实际上从未生效。
/// 只有 Rust 侧有真实文件系统访问权限，走 Tauri command 桥接。
#[tauri::command]
fn resolve_realpath(path: String) -> Result<String, String> {
    std::fs::canonicalize(&path)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("realpath failed for {path}: {e}"))
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

/// 修复（2026-07-02，用户实测发现）：spawn 出去的 claude/codex 进程报
/// `env: node: No such file or directory`。根因不是找不到 claude 本身——
/// `resolve_cli_program`/`find_in_common_locations` 已经能用绝对路径找到 claude——
/// 而是 claude 这类 CLI 脚本内部常有 `#!/usr/bin/env node` 这种 shebang，
/// 这一步是**子进程自己**按它继承到的 PATH 再查一次 node，父进程这边解析出的
/// 绝对路径救不了这一步。GUI app（Dock/Finder 启动，或某些 Tauri dev 场景）
/// 继承的进程 PATH 通常比用户交互式 shell 的 PATH 窄得多，不含 nvm 管理的
/// node 目录，所以必须把这些目录也塞进传给子进程的 PATH 里。
/// 复用 find_in_common_locations 同一套目录来源（homebrew/local/.nvm）。
fn extra_path_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")];
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".local/bin"));
        let nvm_versions = home.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
            let mut node_bins: Vec<PathBuf> = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path().join("bin"))
                .filter(|p| p.is_dir())
                .collect();
            node_bins.sort();
            node_bins.reverse(); // 新版本优先
            dirs.extend(node_bins);
        }
    }
    dirs
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
            CommandEvent::Stdout(bytes) => CliStreamEvent::Stdout {
                line: String::from_utf8_lossy(&bytes).trim_end().to_string(),
            },
            CommandEvent::Stderr(bytes) => CliStreamEvent::Stderr {
                line: String::from_utf8_lossy(&bytes).trim_end().to_string(),
            },
            CommandEvent::Terminated(p) => CliStreamEvent::Terminated { code: p.code },
            CommandEvent::Error(err) => CliStreamEvent::Error {
                message: err,
                kind: CliErrorKind::ExecutionFailed,
            },
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

/// web_fetch 工具的后端实现（2026-07-05 新增）。
/// 之前 web-fetch-tool.ts 直接在 webview 里调 `fetch()`，那是浏览器的 JS fetch，
/// 会被 CORS 挡：目标网站没有回 `Access-Control-Allow-Origin`（绝大多数普通网站都没有，
/// 它们只预期被浏览器直接打开，不预期被别的来源用 JS 跨域读取），浏览器引擎就直接不让
/// JS 拿到响应内容——不管背后是哪个模型在调用工具，结果都一样抓不到。
/// 这里换成后端直接发 HTTP 请求：不是浏览器上下文，CORS 这个限制根本不适用，天然绕开。
/// SSRF 防护跟 TS 侧 `assertSafeUrl` 保持一致（双保险：前端调用前也会挡一次内网地址）。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FetchResult {
    status: u16,
    final_url: String,
    content_type: String,
    body: String,
}

const FETCH_TIMEOUT_SECS: u64 = 15;
const FETCH_MAX_BYTES: usize = 2_000_000; // 2MB 硬上限，防止超大响应拖爆内存

fn is_private_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 10
        || o[0] == 127
        || (o[0] == 169 && o[1] == 254)
        || (o[0] == 172 && (16..=31).contains(&o[1]))
        || (o[0] == 192 && o[1] == 168)
        || o[0] == 0
}

fn assert_safe_url(raw_url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(raw_url).map_err(|_| "URL 格式不合法".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!("不支持的协议：{}", parsed.scheme()));
    }
    let host = parsed.host_str().unwrap_or_default().to_lowercase();
    if host.is_empty() || host == "localhost" || host == "0.0.0.0" || host == "::1" || host.ends_with(".local") {
        return Err("拒绝访问本机/内网地址".to_string());
    }
    if let Ok(ipv4) = host.parse::<std::net::Ipv4Addr>() {
        if is_private_ipv4(ipv4) {
            return Err("拒绝访问内网/链路本地 IP 段".to_string());
        }
    }
    Ok(parsed)
}

#[tauri::command]
async fn fetch_url_backend(url: String) -> Result<FetchResult, String> {
    let parsed = assert_safe_url(&url)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        )
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;

    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let bytes = resp.bytes().await.map_err(|e| format!("读取响应失败：{e}"))?;
    let clipped = if bytes.len() > FETCH_MAX_BYTES {
        &bytes[..FETCH_MAX_BYTES]
    } else {
        &bytes[..]
    };
    let body = String::from_utf8_lossy(clipped).into_owned();

    Ok(FetchResult {
        status,
        final_url,
        content_type,
        body,
    })
}

/// Tier 3（真正渲染页面）：给 `web_fetch` 兜底用（2026-07-05 新增）。
/// `fetch_url_backend`（Tier 1）只是发一趟裸 HTTP 请求，遇到"内容要等 JS 跑完才出现"的
/// 单页应用（SPA）、或者故意只放行真浏览器的反爬网站，拿到的只是个空壳。这里退而求其次：
/// 真开一个（不可见的）浏览器窗口把网址加载一遍，等它跑完自己的 JS，再把渲染出来的正文
/// 读出来——跟真人打开网页走的是同一条路，能过大多数"只认真浏览器"的检测。
///
/// 拿渲染结果这一步比想的绕：`initialization_script` 注入的 JS 没法把返回值直接传回
/// Rust（eval 是单向的），所以走一次"反向 IPC"——页面加载完，注入的脚本自己调
/// `report_rendered_page` 命令把提取到的文本回传，Rust 这边用 requestId 对应的
/// oneshot::Sender 收着；`fetch_url_rendered` 在另一头 await 这个 receiver（见
/// RenderChannels 定义），加了超时兜底，避免页面挂住导致这个命令永远不返回。
const RENDER_TIMEOUT_SECS: u64 = 20;
const RENDER_EXTRA_WAIT_MS: u64 = 1500;
const RENDER_TEXT_MAX_CHARS: usize = 200_000;

static RENDER_REQUEST_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 隐藏窗口里注入的脚本调这个命令，把提取到的正文回传给等在 fetch_url_rendered 里的调用方。
#[tauri::command]
fn report_rendered_page(request_id: String, text: String, channels: State<'_, RenderChannels>) {
    if let Some(tx) = channels.0.lock().unwrap().remove(&request_id) {
        let _ = tx.send(text);
    }
}

#[tauri::command]
async fn fetch_url_rendered(
    app: tauri::AppHandle,
    channels: State<'_, RenderChannels>,
    url: String,
) -> Result<FetchResult, String> {
    assert_safe_url(&url)?;
    let target: tauri::Url = url.parse().map_err(|_| "URL 格式不合法".to_string())?;

    let seq = RENDER_REQUEST_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let request_id = format!("{}-{seq}", fnv1a_hex(&url));
    let label = format!("render-{request_id}");

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    channels.0.lock().unwrap().insert(request_id.clone(), tx);

    // load 事件后再等一小段时间：很多 SPA 在 load 触发后还要发几个 API 请求才把内容填进去，
    // 直接在 load 那一刻读 innerText 经常还是空的。
    let script = format!(
        r#"window.addEventListener('load', function () {{
  setTimeout(function () {{
    var text = '';
    try {{ text = document.body ? document.body.innerText : ''; }} catch (e) {{}}
    try {{
      window.__TAURI__.core.invoke('report_rendered_page', {{ requestId: '{request_id}', text: text }});
    }} catch (e) {{}}
  }}, {RENDER_EXTRA_WAIT_MS});
}});"#
    );

    let window = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(target))
        .visible(false)
        .initialization_script(script)
        .build()
        .map_err(|e| format!("打开渲染窗口失败：{e}"))?;

    let outcome = tokio::time::timeout(Duration::from_secs(RENDER_TIMEOUT_SECS), rx).await;

    let _ = window.close();
    channels.0.lock().unwrap().remove(&request_id);

    match outcome {
        Ok(Ok(text)) => {
            let clipped: String = text.chars().take(RENDER_TEXT_MAX_CHARS).collect();
            Ok(FetchResult {
                status: 200,
                final_url: url,
                content_type: "text/plain".to_string(),
                body: clipped,
            })
        }
        Ok(Err(_)) => Err("渲染窗口提前关闭，没能拿到内容".to_string()),
        Err(_) => Err(format!("渲染超时（>{RENDER_TIMEOUT_SECS}s）")),
    }
}

/// FNV-1a（64位）——纯手写，零依赖，输出跨 Rust 版本/平台 100% 稳定。
/// 2026-07-02 代码审查发现：最初用的是 `std::collections::hash_map::DefaultHasher`
/// （SipHash），标准库明确不保证其输出跨版本/跨进程稳定，升级 Rust 工具链后同一
/// workspace 算出的目录名可能变化，旧影子仓库变孤儿。FNV-1a 是教科书级公开算法，
/// 实现完全在我们自己代码里，不依赖任何 std 内部细节，不会有这个问题。
fn fnv1a_hex(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// 2.1 步骤2/3 修复（2026-07-02）：非 git 工作文件夹的影子仓库路径。
/// 参考 OpenCode `snapshot/index.ts` 的思路——快照仓库放在应用私有数据目录，
/// 用 `--git-dir`/`--work-tree` 跟用户目录分离，不会在用户项目里冒出个 `.git`。
/// 用 workspace 路径的 hash 做稳定目录名。
/// 2026-07-02 代码审查发现：不同写法的同一目录（尾部斜杠、符号链接 vs 真实路径）会
/// 算出不同 hash，导致"开启保护"和后续 commit 用的目录对不上——先 canonicalize，
/// 失败（目录当时不存在等）就退回裁剪尾部斜杠的原始字符串，保证 init 和 commit 两次
/// 调用只要传的是同一个真实目录，算出来的 hash 就一致。
fn shadow_git_dir_for_workspace(app: &tauri::AppHandle, workspace: &str) -> Result<PathBuf, String> {
    let normalized = std::fs::canonicalize(workspace)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| workspace.trim_end_matches('/').to_string());
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(base.join("snapshots").join(fnv1a_hex(&normalized)))
}

/// 2.1 步骤2/3 修复：用户主动点击"开启修改保护"时调用——在应用私有目录里给这个
/// 工作文件夹初始化一个影子 git 仓库（不修改用户文件夹本身，不会冒出 `.git`）。
/// 幂等：仓库已存在时 `git init` 本身就是安全的空操作。
/// 顺便配好 user.name/user.email——这是应用内部管理的仓库，不能依赖用户机器上
/// 有没有配过全局 git 身份（很多 vibe coder 用户可能从没跑过 git，配了才不会
/// 每次 commit 都报"Please tell me who you are"）。
#[tauri::command]
async fn init_shadow_git_repo(app: tauri::AppHandle, workspace: String) -> Result<(), String> {
    let git_dir = shadow_git_dir_for_workspace(&app, &workspace)?;
    std::fs::create_dir_all(&git_dir).map_err(|e| format!("failed to create shadow git dir: {e}"))?;
    let git_dir_flag = format!("--git-dir={}", git_dir.to_string_lossy());
    let work_tree_flag = format!("--work-tree={workspace}");

    let output = app
        .shell()
        .command("git")
        .args([git_dir_flag.as_str(), work_tree_flag.as_str(), "init"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }

    // 2026-07-02 代码审查发现：原来只检查 spawn 是否成功，没检查 git config 命令本身的
    // 退出码——如果 config 失败（比如权限问题），函数照样返回 Ok(())，用户以为"开启成功"，
    // 但后续 commit 会因为没有 user.name/user.email 报错，表现跟没开启保护一模一样。
    for (key, value) in [("user.name", "Cosmgrid Agent"), ("user.email", "agent@cosmgrid.local")] {
        let cfg = app
            .shell()
            .command("git")
            .args([git_dir_flag.as_str(), "config", key, value])
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if !cfg.status.success() {
            return Err(format!(
                "failed to set {key}: {}",
                String::from_utf8_lossy(&cfg.stderr)
            ));
        }
    }
    Ok(())
}

/// 给单个文件做一次 git commit（AI 写操作后的回滚兜底）。
/// v0.7 阶段4b 增强：路径与消息作为**独立参数**传给 git（不经 sh -c），杜绝 shell 注入。
/// 2.1 步骤2/3 修复：workspace 本身不是 git 仓库时，落回检查有没有已初始化的影子仓库
/// （用户点过"开启修改保护"），有就用 `--git-dir`/`--work-tree` 走影子仓库提交；
/// 两者都没有 → 返回 false（不报错，调用方据此标记 reversible，UI 提示用户去开启保护）。
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
    if add.status.success() {
        let commit = app
            .shell()
            .command("git")
            .args(["commit", "-m", &message, "--", &rel_path])
            .current_dir(&workspace)
            .output()
            .await
            .map_err(|e| e.to_string())?;
        return Ok(commit.status.success());
    }

    // workspace 本身不是 git 仓库 → 查影子仓库存不存在（用户是否点过"开启修改保护"）
    let shadow_dir = shadow_git_dir_for_workspace(&app, &workspace)?;
    if !shadow_dir.join("HEAD").exists() {
        return Ok(false); // 没开启影子保护，如实告知（不是"没做完"，是用户还没选择开启）
    }

    let git_dir_flag = format!("--git-dir={}", shadow_dir.to_string_lossy());
    let work_tree_flag = format!("--work-tree={workspace}");
    let shadow_add = app
        .shell()
        .command("git")
        .args([git_dir_flag.as_str(), work_tree_flag.as_str(), "add", "--", &rel_path])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !shadow_add.status.success() {
        return Ok(false);
    }
    let shadow_commit = app
        .shell()
        .command("git")
        .args([git_dir_flag.as_str(), work_tree_flag.as_str(), "commit", "-m", &message, "--", &rel_path])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(shadow_commit.status.success())
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
        .manage(RenderChannels::default())
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
            fetch_url_backend,
            fetch_url_rendered,
            report_rendered_page,
            git_commit_file,
            git_read,
            init_shadow_git_repo,
            resolve_realpath,
            set_menu_language
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
