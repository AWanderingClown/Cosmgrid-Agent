// D11（2026-07-15）：ESLint Flat Config（React + TypeScript）
//
// 设计取向：先"收口"再"收紧"。本轮只引入 ESLint 并把高频问题以 warn 暴露，
// 不一次性大规模改全仓库（见历史债修复交接方案 D11）。后续可逐步把 warn 升 error。
//
// - 不用 type-checked 规则（不依赖 tsc 工程视图），保证 lint 快且不因类型信息报错。
// - react-hooks 的 rules-of-hooks 维持 error（违反 Hook 规则是真实 bug）；
//   exhaustive-deps 仅 warn（提示性）。
// - 全量扫描忽略构建产物与生成物：dist / coverage / src-tauri/target / scripts。

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "coverage",
      "src-tauri/target",
      "node_modules",
      "scripts/**",
      "**/*.config.*",
      "**/*.cjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      // ---- 正确性（保持 error）----
      "react-hooks/rules-of-hooks": "error",
      // ---- 提示性（warn，收口用）----
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn",
      // 收口阶段：recommended 集里对存量代码噪音较大的规则先降 warn，避免 pnpm lint 直接挂掉。
      // 后续可逐步升 error。
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "no-useless-escape": "warn",
      "require-yield": "warn",
      "no-debugger": "warn",
      "no-console": "off",
      "eqeqeq": ["warn", "smart"],
      "prefer-const": "warn",
      "no-duplicate-imports": "warn",
    },
  },
);
