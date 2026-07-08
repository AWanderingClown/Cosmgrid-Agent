import { describe, expect, it } from "vitest";
import { buildDidOpenParams, formatLspDiagnostics, positionToLsp } from "../protocol";

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
});
