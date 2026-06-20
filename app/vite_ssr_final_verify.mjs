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
  console.log("=== zh-CN 测 ===");
  for (const k of ["app.brandSubtitle", "app.sidebar.chat", "templates.title", "templates.noModels", "settings.title", "workRoles.main_chat", "common.cancel", "builtinTemplates.fullstack_web.name", "errorClassifier.rate_limit", "chat.switchedTo"]) {
    console.log(`  t('${k}') = ${JSON.stringify(i18n.t(k))}`);
  }
  console.log("\n=== interpolation ===");
  console.log("  t('chat.switchedTo', {name: 'Opus'}):", JSON.stringify(i18n.t("chat.switchedTo", { name: "Opus 4.8" })));
  console.log("  t('chat.inputTokens', {count: 1234}):", JSON.stringify(i18n.t("chat.inputTokens", { count: 1234 })));

  console.log("\n=== 切到 en-US ===");
  await i18n.changeLanguage("en-US");
  for (const k of ["app.brandSubtitle", "templates.title", "settings.title", "workRoles.main_chat", "common.cancel", "chat.switchedTo", "errorClassifier.rate_limit"]) {
    console.log(`  t('${k}') = ${JSON.stringify(i18n.t(k))}`);
  }
} catch (e) {
  console.error("ERR:", e.message);
} finally {
  await vite.close();
}
