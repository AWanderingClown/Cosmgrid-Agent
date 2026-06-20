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
  // 第一次加载 i18n
  const mod1 = await vite.ssrLoadModule("/src/i18n/index.ts");
  const i18n1 = mod1.default;
  await i18n1.changeLanguage("zh-CN");
  console.log("=== 第一次加载 + use plugins + 嵌套 ===");
  console.log("t('app.brandSubtitle'):", JSON.stringify(i18n1.t("app.brandSubtitle")));

  // 看 services 状态
  console.log("services keys:", Object.keys(i18n1.services ?? {}));
  console.log("has languageDetector?", !!i18n1.services.languageDetector);

  // 关键：看 resourceStore 实际存的什么
  const rs = i18n1.services.resourceStore;
  const zhTrans = rs.data?.["zh-CN"]?.translation;
  console.log("zhTrans type:", typeof zhTrans);
  console.log("zhTrans.app.brandSubtitle:", JSON.stringify(zhTrans?.app?.brandSubtitle));
  // 关键：看 resourceStore 是按什么 key 存的
  console.log("zhTrans top keys:", Object.keys(zhTrans ?? {}).slice(0, 5));
  // 找 i18next 内部 resourceStore 的 data 结构
  console.log("rs.data structure keys:", Object.keys(rs.data ?? {}));
  // 关键：看 zh-CN 是按 nested 还是 flat 存
  console.log("rs.data['zh-CN'] keys:", Object.keys(rs.data?.["zh-CN"] ?? {}));
  const zhCnValue = rs.data?.["zh-CN"];
  console.log("zhCnValue type:", typeof zhCnValue);
  console.log("zhCnValue.translation top keys:", Object.keys(zhCnValue?.translation ?? {}).slice(0, 5));
} catch (e) {
  console.error("ERR:", e.message);
} finally {
  await vite.close();
}
