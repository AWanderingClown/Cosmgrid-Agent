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
  const myI18n = mod.default;
  await myI18n.changeLanguage("zh-CN");

  console.log("=== myI18n (默认实例) ===");
  // 看 i18next 内部 ResourceStore
  const store = myI18n.services?.resourceStore;
  console.log("resourceStore exists?", !!store);
  if (store) {
    // i18next 内部用 namespacedResources 存：{ lang: { namespace: { ... } } }
    const namespaced = myI18n.services?.resourceStore?.data ?? {};
    console.log("namespacedResources languages:", Object.keys(namespaced));
    console.log("namespacedResources['zh-CN'] keys:", Object.keys(namespaced["zh-CN"] ?? {}));
    const zhTrans = namespaced["zh-CN"]?.translation;
    console.log("zh-CN.translation type:", typeof zhTrans);
    console.log("zh-CN.translation.app exists?", !!zhTrans?.app);
    console.log("zh-CN.translation.app.brandSubtitle:", JSON.stringify(zhTrans?.app?.brandSubtitle));
  }
  console.log("\nmyI18n.t('app.brandSubtitle'):", JSON.stringify(myI18n.t("app.brandSubtitle")));

  console.log("\n=== 跟 createInstance 比 ===");
  const newI18n = i18next.createInstance();
  await newI18n.init({ resources: { "zh-CN": { translation: { app: { brandSubtitle: "智能核心管理层" } } } }, lng: "zh-CN" });
  const newStore = newI18n.services?.resourceStore;
  console.log("newI18n namespacedResources languages:", Object.keys(newStore?.data ?? {}));
  const newZhTrans = newStore?.data?.["zh-CN"]?.translation;
  console.log("newZhTrans type:", typeof newZhTrans);
  console.log("newZhTrans.app exists?", !!newZhTrans?.app);
  console.log("newZhTrans.app.brandSubtitle:", JSON.stringify(newZhTrans?.app?.brandSubtitle));
  console.log("newI18n.t('app.brandSubtitle'):", JSON.stringify(newI18n.t("app.brandSubtitle")));

  // 关键对比：i18next 服务状态
  console.log("\n=== 服务初始化状态 ===");
  console.log("myI18n.services keys:", Object.keys(myI18n.services ?? {}));
  console.log("newI18n.services keys:", Object.keys(newI18n.services ?? {}));
} catch (e) {
  console.error("ERR:", e.message);
} finally {
  await vite.close();
}
