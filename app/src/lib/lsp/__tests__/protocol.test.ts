import { describe, expect, it } from "vitest";
import {
  buildDidOpenParams,
  filePathToUri,
  formatLspDiagnostics,
  positionToLsp,
  uriToFilePath,
} from "../protocol";

describe("lsp protocol helpers", () => {
  it("converts 1-based editor positions to 0-based LSP positions", () => {
    expect(positionToLsp({ line: 12, character: 5 })).toEqual({ line: 11, character: 4 });
    expect(positionToLsp({ line: 0, character: 0 })).toEqual({ line: 0, character: 0 });
  });

  it("builds didOpen params from an absolute file path and content", () => {
    const params = buildDidOpenParams({
      path: "/repo/src/App.tsx",
      languageId: "typescriptreact",
      content: "export default function App() {}",
    });

    expect(params.textDocument).toMatchObject({
      uri: "file:///repo/src/App.tsx",
      languageId: "typescriptreact",
      version: 1,
      text: "export default function App() {}",
    });
  });

  it("formats diagnostics into concise model-readable text", () => {
    const output = formatLspDiagnostics("/repo/src/App.ts", [
      {
        range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } },
        severity: 1,
        source: "ts",
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ]);

    expect(output).toContain("src/App.ts");
    expect(output).toContain("3:5");
    expect(output).toContain("error");
    expect(output).toContain("Type 'string'");
  });

  it("converts file URIs including spaces and preserves non-file URIs", () => {
    expect(filePathToUri("repo/a b.ts")).toBe("file:///repo/a%20b.ts");
    expect(uriToFilePath("file:///repo/a%20b.ts")).toBe("/repo/a b.ts");
    expect(uriToFilePath("https://example.test/a.ts")).toBe("https://example.test/a.ts");
  });

  it("formats empty diagnostics and all severity labels", () => {
    expect(formatLspDiagnostics("/repo/a.ts", [])).toContain("has no diagnostics");
    const diagnostics = [2, 3, 4, undefined].map((severity, index) => ({
      range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } },
      severity,
      message: `message-${index}`,
    }));
    const output = formatLspDiagnostics("/repo/a.ts", diagnostics);
    expect(output).toContain("warning");
    expect(output).toContain("info");
    expect(output).toContain("hint");
    expect(output).toContain("diagnostic");
  });

  it("honors an explicit document version", () => {
    expect(buildDidOpenParams({
      path: "/repo/a.ts",
      languageId: "typescript",
      content: "",
      version: 7,
    }).textDocument.version).toBe(7);
  });
});
