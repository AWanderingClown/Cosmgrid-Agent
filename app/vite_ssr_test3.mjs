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

  // 用 createInstance 加载同样嵌套 resources
  const res = {
    common: { cancel: "取消" },
    app: { brandSubtitle: "智能核心管理层", sidebar: { chat: "智能对话" } },
    templates: { title: "项目角色模板" },
  };
  const newI18n = i18next.createInstance();
  await newI18n.init({ resources: { "zh-CN": { translation: res } }, lng: "zh-CN" });
  console.log("=== createInstance 测 ===");
  console.log("t('app.brandSubtitle'):", JSON.stringify(newI18n.t("app.brandSubtitle")));

  // 看默认实例的 i18n.isInitialized
  console.log("\n=== 默认 i18n 状态 ===");
  console.log("myI18n.language:", myI18n.language);
  console.log("myI18n.isInitialized:", myI18n.isInitialized);

  // 找 isInitialized 在哪里
  const opts = myI18n.options ?? {};
  console.log("options keys:", Object.keys(opts).slice(0, 20));
  console.log("resources keys:", Object.keys(opts.resources ?? {}));
  console.log("defaultNS:", opts.defaultNS);
  console.log("ns:", opts.ns);
  console.log("fallbackNS:", opts.fallbackNS);
  console.log("keySeparator:", opts.keySeparator);
  console.log("default resources[zh-CN]:", JSON.stringify(opts.resources?.["zh-CN"]?.translation?.app, null, 2)?.slice(0, 300));

  // t() 直接走 lookup
  console.log("\n=== t() 不同方式 ===");
  console.log("t('app.brandSubtitle'):", JSON.stringify(myI18n.t("app.brandSubtitle")));
  console.log("t('app.brandSubtitle', { defaultValue: 'fallback' }):", JSON.stringify(myI18n.t("app.brandSubtitle", { defaultValue: "fallback" })));
} catch (e) {
  console.error("ERR:", e.message);
  console.error(e.stack?.split("\n").slice(0, 5).join("\n"));
} finally {
  await vite.close();
}
