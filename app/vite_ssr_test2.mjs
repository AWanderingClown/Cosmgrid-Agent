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
  const mod = await vite.ssrLoadModule("/src/i18n/index.ts");
  const i18n = mod.default;
  const zhRes = i18n.options.resources?.["zh-CN"]?.translation ?? {};

  console.log("=== Test A: 现有平铺形式 ===");
  console.log("t('app.brandSubtitle'):", JSON.stringify(i18n.t("app.brandSubtitle")));

  console.log("\n=== Test B: 改用嵌套形式 ===");
  // 重新 init with 嵌套
  const nestedRes = {
    common: { cancel: "取消" },
    app: { brandSubtitle: "智能核心管理层", sidebar: { chat: "智能对话" } },
    templates: { title: "项目角色模板" },
  };
  const i18n2 = i18next.createInstance();
  await i18n2.init({ resources: { "zh-CN": { translation: nestedRes } }, lng: "zh-CN" });
  console.log("t('app.brandSubtitle'):", JSON.stringify(i18n2.t("app.brandSubtitle")));
  console.log("t('app.sidebar.chat'):", JSON.stringify(i18n2.t("app.sidebar.chat")));
  console.log("t('templates.title'):", JSON.stringify(i18n2.t("templates.title")));

  console.log("\n=== Test C: 平铺 vs 嵌套混合 ===");
  // 看 i18next 内部 resources 怎么存
  const internalRes = i18n2.options.resources?.["zh-CN"]?.translation;
  console.log("internal keys (first 5):", Object.keys(internalRes).slice(0, 5));
  console.log("internal app.brandSubtitle:", internalRes?.["app.brandSubtitle"]);
} catch (e) {
  console.error("ERR:", e.message);
} finally {
  await vite.close();
}
