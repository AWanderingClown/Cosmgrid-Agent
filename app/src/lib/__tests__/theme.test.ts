import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getInitialTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  LEGACY_THEME_STORAGE_KEY,
} from "../theme";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  (globalThis as any).localStorage = {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => store.set(key, value)),
    removeItem: vi.fn((key: string) => store.delete(key)),
  };
  (globalThis as any).window = {
    matchMedia: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  };
});

describe("theme", () => {
  it("defaults to following the system theme", () => {
    expect(getInitialTheme()).toBe("system");
  });

  it("prefers the new explicit theme setting", () => {
    store.set(THEME_STORAGE_KEY, "dark");
    expect(getInitialTheme()).toBe("dark");
  });

  it("does not let the old implicit dark default pin new installs to dark", () => {
    store.set(LEGACY_THEME_STORAGE_KEY, "dark");
    expect(getInitialTheme()).toBe("system");
  });

  it("resolves system using prefers-color-scheme", () => {
    (globalThis as any).window.matchMedia = vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    expect(resolveTheme("system")).toBe("dark");
  });
});
