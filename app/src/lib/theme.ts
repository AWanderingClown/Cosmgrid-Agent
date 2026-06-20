// 主题切换 hook：浅/深模式
// - 启动时读 localStorage > 系统偏好 > 默认浅色
// - 切换时写 localStorage + html.class
import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "cosmgrid.theme";

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
  if (stored === "light" || stored === "dark") return stored;
  // 默认深色（参考官网风格）
  return "dark";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
  // 给 macOS 标题栏一个提示（webview 标题栏颜色）
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute(
      "content",
      theme === "dark" ? "#0F172A" : "#FFFFFF",
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

  // 主题变化时同步
  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  // 监听系统主题变化（用户没手动设过时跟随）
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored !== "light" && stored !== "dark") {
        setThemeState(e.matches ? "dark" : "light");
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return {
    theme,
    toggleTheme: () => setThemeState((t) => (t === "light" ? "dark" : "light")),
    setTheme: setThemeState,
  };
}
