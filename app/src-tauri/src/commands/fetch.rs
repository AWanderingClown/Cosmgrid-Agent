//! web_fetch 工具的后端实现（2026-07-05 新增）。
//! 之前 web-fetch-tool.ts 直接在 webview 里调 `fetch()`，那是浏览器的 JS fetch，
//! 会被 CORS 挡：目标网站没有回 `Access-Control-Allow-Origin`（绝大多数普通网站都没有，
//! 它们只预期被浏览器直接打开，不预期被别的来源用 JS 跨域读取），浏览器引擎就直接不让
//! JS 拿到响应内容——不管背后是哪个模型在调用工具，结果都一样抓不到。
//! 这里换成后端直接发 HTTP 请求：不是浏览器上下文，CORS 这个限制根本不适用，天然绕开。
//! SSRF 防护统一走 `crate::security::assert_safe_url`（双保险：前端调用前也会挡一次内网地址）。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

use crate::security::{assert_safe_url, fnv1a_hex};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResult {
    status: u16,
    final_url: String,
    content_type: String,
    body: String,
}

const FETCH_TIMEOUT_SECS: u64 = 15;
const FETCH_MAX_BYTES: usize = 2_000_000; // 2MB 硬上限，防止超大响应拖爆内存

#[tauri::command]
pub async fn fetch_url_backend(url: String) -> Result<FetchResult, String> {
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

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
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

/// fetch_url_rendered 的等待表（2026-07-05 新增）：requestId → oneshot 发送端。
/// 隐藏窗口里的页面加载完、脚本执行完之后，通过 report_rendered_page 命令把提取到的文本
/// 传回来，按 requestId 找到对应的 oneshot::Sender 塞进去，唤醒等在另一头的
/// fetch_url_rendered（它在 await 这个 receiver，见下方实现和注释）。
#[derive(Default)]
pub struct RenderChannels(Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>);

/// 隐藏窗口里注入的脚本调这个命令，把提取到的正文回传给等在 fetch_url_rendered 里的调用方。
#[tauri::command]
pub fn report_rendered_page(request_id: String, text: String, channels: State<'_, RenderChannels>) {
    if let Some(tx) = channels.0.lock().unwrap().remove(&request_id) {
        let _ = tx.send(text);
    }
}

#[tauri::command]
pub async fn fetch_url_rendered(
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

    let window =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(target))
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
