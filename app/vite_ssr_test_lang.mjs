import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";
import i18next from "i18next";
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
  const res = {
    common: { cancel: "取消" },
    app: { brandSubtitle: "智能核心管理层" },
  };
  // 只用 LanguageDetector
  const i = i18next.createInstance();
  await i.use(LanguageDetector).init({ resources: { "zh-CN": { translation: res } }, lng: "zh-CN" });
  console.log("=== use(LanguageDetector) only + 嵌套 ===");
  console.log("language:", i.language);
  console.log("t('app.brandSubtitle'):", JSON.stringify(i.t("app.brandSubtitle")));
  // 看 resources 内部
  const zhTrans = i.services.resourceStore.data?.["zh-CN"]?.translation;
  console.log("zhTrans.app.brandSubtitle:", JSON.stringify(zhTrans?.app?.brandSubtitle));
  // 看是不是 LanguageDetector 改了 resources
  console.log("all languages in resourceStore:", Object.keys(i.services.resourceStore.data ?? {}));
  // 看 LanguageDetector 加了什么 services
  console.log("services:", Object.keys(i.services ?? {}));
} catch (e) {
  console.error("ERR:", e.message);
} finally {
  await vite.close();
}
