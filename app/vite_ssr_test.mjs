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
  console.log("language:", i18n.language);
  console.log("\n=== Test t() zh-CN ===");
  for (const k of ["app.brandSubtitle", "app.sidebar.chat", "templates.title", "templates.noModels", "settings.title", "workRoles.main_chat", "builtinTemplates.fullstack_web.name", "common.cancel", "errorClassifier.rate_limit", "nonexistent.key"]) {
    console.log(`  t('${k}') = ${JSON.stringify(i18n.t(k))}`);
  }
  console.log("\n=== Test changeLanguage to en-US ===");
  await i18n.changeLanguage("en-US");
  for (const k of ["app.brandSubtitle", "templates.title", "settings.title"]) {
    console.log(`  t('${k}') = ${JSON.stringify(i18n.t(k))}`);
  }
  console.log("\n=== Test interpolation ===");
  await i18n.changeLanguage("zh-CN");
  console.log("  t('chat.switchedTo', { name: 'Opus 4.8' }) =", JSON.stringify(i18n.t("chat.switchedTo", { name: "Opus 4.8" })));
} catch (e) {
  console.error("ERR:", e.message);
} finally {
  await vite.close();
}
