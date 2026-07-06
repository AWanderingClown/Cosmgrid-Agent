import { describe, expect, it } from "vitest";
import { detectLanguage } from "../types";

describe("detectLanguage", () => {
  it.each([
    ["app.tsx", "typescript"],
    ["lib.ts", "typescript"],
    ["main.jsx", "javascript"],
    ["index.js", "javascript"],
    ["data.json", "json"],
    ["README.md", "markdown"],
    ["script.py", "python"],
    ["style.css", "css"],
    ["index.html", "html"],
    ["logo.svg", "html"],
    ["LICENSE", "text"],
  ])("%s -> %s", (path, language) => {
    expect(detectLanguage(path)).toBe(language);
  });
});
