import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, { url: "http://localhost:1420/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, writable: true, configurable: true });

const vite = await createServer({
  configFile: path.join(__dirname, "vite.config.ts"),
  root: __dirname,
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
});

try {
  const mod = await vite.ssrLoadModule("/src/i18n/index.ts");
  const myI18n = mod.default;
  await myI18n.changeLanguage("zh-CN");
  console.log("language:", myI18n.language);
  console.log("t('app.brandSubtitle'):", JSON.stringify(myI18n.t("app.brandSubtitle")));

  // 看 i18n 服务的"init 阶段"
  console.log("\ni18n.services.languageDetector?", !!myI18n.services.languageDetector);

  // 直接手动看 lookup 走哪条路径
  // 用 i18next 内部 t 函数的 key 解析
  const internals = myI18n.services;
  console.log("internals.resourceStore.data[zh-CN].translation.app:", JSON.stringify(internals.resourceStore.data["zh-CN"].translation.app, null, 2)?.slice(0, 200));

  // 找 t() 实际 lookup 函数
  const t = myI18n.t.bind(myI18n);
  console.log("t.toString().slice(0,200):", t.toString().slice(0, 200));

  // 查 i18n 的 t 内部实现
  // i18next 26 的 t() 内部用 lookup 函数从 resourceStore 查
  // 关键：fallback 是否走？
  console.log("\n=== 测试 fallback ===");
  await myI18n.changeLanguage("xx-XX");  // 不支持的语言
  console.log("language after xx-XX:", myI18n.language);
  console.log("t('app.brandSubtitle'):", JSON.stringify(myI18n.t("app.brandSubtitle")));
} catch (e) {
  console.error("ERR:", e.message);
} finally {
  await vite.close();
}
