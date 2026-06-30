import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],

  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/")) {
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "vendor-react";
            if (id.includes("/node_modules/lucide-react/")) return "vendor-icons";
            if (id.includes("/node_modules/@tauri-apps/")) return "vendor-tauri";
            if (id.includes("/node_modules/@radix-ui/")) return "vendor-radix";
            if (id.includes("/node_modules/i18next/") || id.includes("/node_modules/react-i18next/")) return "vendor-i18n";
            if (id.includes("/node_modules/underscore/")) return "vendor-underscore";
            if (id.includes("/node_modules/zod/")) return "vendor-zod";
            if (
              /[\\/]node_modules[\\/](react-markdown|remark-|rehype-|unified|mdast-|micromark|hast-|unist-|vfile|markdown-table|property-information|space-separated-tokens|comma-separated-tokens|character-entities|decode-named-character-reference|devlop|bail|ccount|longest-streak|trim-lines|zwitch|html-url-attributes|estree-)/.test(id)
            ) {
              return "vendor-markdown";
            }
            if (id.includes("/node_modules/@ai-sdk/openai/")) return "vendor-ai-openai";
            if (id.includes("/node_modules/@ai-sdk/anthropic/")) return "vendor-ai-anthropic";
            if (id.includes("/node_modules/@ai-sdk/google/")) return "vendor-ai-google";
            if (id.includes("/node_modules/@ai-sdk/") || id.includes("/node_modules/ai/")) return "vendor-ai-core";
          }
          if (id.endsWith("/src/lib/db.ts")) return "app-db";
          if (id.includes("/src/i18n/")) return "app-i18n";
        },
      },
    },
  },

  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },

  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
