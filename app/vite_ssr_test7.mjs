import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";

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
  await i18n.changeLanguage("zh-CN");
  console.log("=== createInstance + use plugins ===");
  console.log("language:", i18n.language);
  console.log("services keys:", Object.keys(i18n.services ?? {}));
  console.log("has languageDetector?", !!i18n.services.languageDetector);
  console.log("has reactI18next?", !!i18n.services.reactI18next);
  // 看 services.reactI18next 是啥
  if (i18n.services.reactI18next) {
    console.log("reactI18next keys:", Object.keys(i18n.services.reactI18next));
  }

  // 关键测试：直接调内部 lookup
  const zhTrans = i18n.services.resourceStore.data?.["zh-CN"]?.translation;
  console.log("\n=== 直接查 resourceStore ===");
  console.log("zhTrans?.app?.brandSubtitle:", JSON.stringify(zhTrans?.app?.brandSubtitle));

  // 用 i18next 内部 extractKey
  const keyParts = i18n.services.interpolator?.extractKey?.("app.brandSubtitle", {});
  console.log("interpolator extractKey for 'app.brandSubtitle':", JSON.stringify(keyParts));

  // 关键：resources 是按什么 key 存的
  // 内部资源是 { lang: { namespace: ... } } —— keySeparator 解析后是 [lang, namespace, ...keyParts]
  console.log("\n=== 看实际 translation structure ===");
  console.log("zh-CN.translation top keys:", Object.keys(zhTrans ?? {}));
  // nested 还是 flat?
  const appVal = zhTrans?.app;
  console.log("zhTrans.app is object?", typeof appVal === "object");
  console.log("zhTrans.app.brandSubtitle:", JSON.stringify(zhTrans?.app?.brandSubtitle));
} catch (e) {
  console.error("ERR:", e.message);
} finally {
  await vite.close();
}
