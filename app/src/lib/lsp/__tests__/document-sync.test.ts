import { describe, expect, it } from "vitest";
import { planDocumentSync, type OpenDocumentState } from "../document-sync";

describe("planDocumentSync", () => {
  it("opens a document at version 1", () => {
    expect(planDocumentSync(undefined, "const value = 1;")).toEqual({
      kind: "open",
      state: { content: "const value = 1;", version: 1 },
    });
  });

  it("sends a full-content change and increments the version", () => {
    const previous: OpenDocumentState = { content: "const value = 1;", version: 1 };
    expect(planDocumentSync(previous, "const value = 2;")).toEqual({
      kind: "change",
      state: { content: "const value = 2;", version: 2 },
    });
  });

  it("does not notify when content is unchanged", () => {
    const previous: OpenDocumentState = { content: "same", version: 4 };
    expect(planDocumentSync(previous, "same")).toEqual({
      kind: "unchanged",
      state: previous,
    });
  });
});
