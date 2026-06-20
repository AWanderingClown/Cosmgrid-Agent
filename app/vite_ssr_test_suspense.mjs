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
  const res = {
    common: { cancel: "取消" },
    app: { brandSubtitle: "智能核心管理层" },
    templates: { title: "项目角色模板" },
  };
  // 测 useSuspense: false
  const i = i18next.createInstance();
  await i.use(LanguageDetector).use(initReactI18next).init({
    resources: { "zh-CN": { translation: res } },
    lng: "zh-CN",
    react: { useSuspense: false },
  });
  console.log("=== use(LanguageDetector) + use(initReactI18next) + useSuspense:false ===");
  console.log("t('app.brandSubtitle'):", JSON.stringify(i.t("app.brandSubtitle")));
  console.log("t('templates.title'):", JSON.stringify(i.t("templates.title")));

  // 再测 切到 en-US
  await i.changeLanguage("en-US");
  console.log("\n=== en-US 测（无资源）===");
  console.log("t('app.brandSubtitle'):", JSON.stringify(i.t("app.brandSubtitle")));
  console.log("t('templates.title'):", JSON.stringify(i.t("templates.title")));
} catch (e) {
  console.error("ERR:", e.message);
} finally {
  await vite.close();
}
