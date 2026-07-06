// 主题切换 hook：浅色 / 深色 / 跟随系统
// - 新安装默认跟随系统
// - 用户手动切换后写入新 key；旧版默认写入的 dark 不再锁死主题
import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

export const LEGACY_THEME_STORAGE_KEY = "cosmgrid.theme";
export const THEME_STORAGE_KEY = "cosmgrid.theme.v2";

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getInitialTheme(): Theme {
  if (typeof localStorage === "undefined") return "system";
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (isTheme(stored)) return stored;

  // 旧版启动会把默认 dark 写进 cosmgrid.theme。没有 v2 key 时，把它当作“未选择”，默认跟随系统。
  const legacy = localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
  if (legacy === "light") return "light";
  return "system";
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === "system" ? systemTheme() : theme;
}

function applyTheme(theme: Theme) {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  if (resolved === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
  // 给 macOS 标题栏一个提示（webview 标题栏颜色）
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute(
      "content",
      resolved === "dark" ? "#0F172A" : "#FFFFFF",
    );
  }
}

export function useTheme(): {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;
} {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);

  // 启动时应用（防止首屏闪烁）
  useEffect(() => {
    applyTheme(theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 主题变化时同步用户选择
  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  // 监听系统主题变化（仅“跟随系统”时实时更新外观）
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (theme === "system") applyTheme("system");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  return {
    theme,
    toggleTheme: () => setThemeState((t) => (resolveTheme(t) === "light" ? "dark" : "light")),
    setTheme: setThemeState,
  };
}
