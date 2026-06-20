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

  // 开 debug
  i18n.options.debug = true;

  // t() 调一次 — debug log 会打印 lookup 路径
  console.log("\n=== t('app.brandSubtitle') with debug ===");
  const r = i18n.t("app.brandSubtitle");
  console.log("result:", JSON.stringify(r));
} catch (e) {
  console.error("ERR:", e.message);
} finally {
  await vite.close();
}
