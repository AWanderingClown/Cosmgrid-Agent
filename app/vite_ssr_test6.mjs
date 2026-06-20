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
  console.log("=== 默认 i18n + LanguageDetector + initReactI18next ===");
  console.log("t('app.brandSubtitle'):", JSON.stringify(myI18n.t("app.brandSubtitle")));

  // 关键测试：换 lookup key 风格
  // i18next v26 有 lookup 路径：
  //   1. resources[lang][namespace][keyPath]  (嵌套对象)
  //   2. resources[lang][namespace][keyWithDots]  (平铺)
  console.log("\n直接访问 resourceStore:");
  const store = myI18n.services.resourceStore;
  const zhTrans = store.data?.["zh-CN"]?.translation;
  console.log("zhTrans['app.brandSubtitle']:", JSON.stringify(zhTrans?.["app.brandSubtitle"]));
  console.log("zhTrans['app']:", JSON.stringify(zhTrans?.["app"]));
  console.log("zhTrans.app['brandSubtitle']:", JSON.stringify(zhTrans?.app?.["brandSubtitle"]));

  // 用 translator 内部函数
  const translator = myI18n.services.translator;
  if (translator && translator.translate) {
    console.log("\n=== direct translator.translate ===");
    const result = translator.translate("app.brandSubtitle", { lng: "zh-CN" });
    console.log("translator result:", JSON.stringify(result));
  } else {
    console.log("translator.translate not available");
    console.log("services.translator:", typeof myI18n.services.translator);
  }
} catch (e) {
  console.error("ERR:", e.message);
} finally {
  await vite.close();
}
