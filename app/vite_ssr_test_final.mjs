import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";
import i18next from "i18next";

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
  // 关键测试：createInstance + 不用任何 plugin + 嵌套 resources
  const res = {
    common: { cancel: "取消" },
    app: { brandSubtitle: "智能核心管理层", sidebar: { chat: "智能对话" } },
    templates: { title: "项目角色模板" },
  };
  const i = i18next.createInstance();
  await i.init({ resources: { "zh-CN": { translation: res } }, lng: "zh-CN" });
  console.log("=== createInstance + no plugin + 嵌套 ===");
  console.log("t('app.brandSubtitle'):", JSON.stringify(i.t("app.brandSubtitle")));
  console.log("t('templates.title'):", JSON.stringify(i.t("templates.title")));

  // 然后加载实际 i18n/index.ts 看
  const mod = await vite.ssrLoadModule("/src/i18n/index.ts");
  const myI18n = mod.default;
  await myI18n.changeLanguage("zh-CN");
  console.log("\n=== 默认 i18n + use plugins + 嵌套 ===");
  console.log("t('app.brandSubtitle'):", JSON.stringify(myI18n.t("app.brandSubtitle")));

  // 现在用 use 但不传 LanguageDetector 看
  const i2 = i18next.createInstance();
  // 测：用 initReactI18next 一个 plugin
  const { initReactI18next } = await import("react-i18next");
  await i2.use(initReactI18next).init({ resources: { "zh-CN": { translation: res } }, lng: "zh-CN" });
  console.log("\n=== createInstance + use(initReactI18next) only ===");
  console.log("t('app.brandSubtitle'):", JSON.stringify(i2.t("app.brandSubtitle")));
  console.log("services keys:", Object.keys(i2.services ?? {}));

  // 测：use(LanguageDetector) only
  const { default: LanguageDetector } = await import("i18next-browser-languagedetector");
  const i3 = i18next.createInstance();
  await i3.use(LanguageDetector).init({ resources: { "zh-CN": { translation: res } }, lng: "zh-CN" });
  console.log("\n=== createInstance + use(LanguageDetector) only ===");
  console.log("t('app.brandSubtitle'):", JSON.stringify(i3.t("app.brandSubtitle")));
} catch (e) {
  console.error("ERR:", e.message);
} finally {
  await vite.close();
}
