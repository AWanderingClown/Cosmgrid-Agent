import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "./index.css";
import { initI18n } from "./i18n";
import { ConfirmProvider } from "./components/ui/confirm-dialog";
import { setDefaultRealpathFn } from "@/lib/llm/tools/path-safety";

// 必须先 await i18n init 完成，再 render React。
// 原因：i18next.init() 是 async，React render 时如果 init 还没就绪，t() 找不到 key。
await initI18n();

// 2.2 修复补丁（2026-07-02）：realpath 解析改走 Rust 侧的 resolve_realpath command。
// 之前用 `import("node:fs")` 注入的方式在 Tauri WKWebView 渲染进程里永远静默失败——
// 那不是 Node.js 运行时也不是浏览器，`node:fs` 不会被打包也不会在运行时 resolve，
// 符号链接逃逸防护实际上从未在生产构建里生效过。只有 Rust 侧有真实文件系统访问权限。
// 非 Tauri 环境（如未来的 web 预览）invoke 会 reject，setDefaultRealpathFn 不会被调用，
// path-safety 落回原字符串检查行为。
setDefaultRealpathFn((path: string) => invoke<string>("resolve_realpath", { path }));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ConfirmProvider>
      <App />
    </ConfirmProvider>
  </React.StrictMode>,
);
