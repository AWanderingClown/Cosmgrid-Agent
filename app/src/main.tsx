import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { initI18n } from "./i18n";
import { ConfirmProvider } from "./components/ui/confirm-dialog";

// 必须先 await i18n init 完成，再 render React。
// 原因：i18next.init() 是 async，React render 时如果 init 还没就绪，t() 找不到 key。
await initI18n();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ConfirmProvider>
      <App />
    </ConfirmProvider>
  </React.StrictMode>,
);
