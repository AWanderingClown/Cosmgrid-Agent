import { describe, expect, it } from "vitest";
import {
  applyAppend,
  applyInsertAfter,
  applyInsertBefore,
  applyPrepend,
  applyReplaceLines,
  applySetLine,
} from "../edit-operation-primitives";
import { applyHashlineEditsWithReport } from "../edit-operations";
import { collectLineRefs, detectOverlappingRanges, getEditLineNumber } from "../edit-ordering";
import { dedupeEdits } from "../edit-deduplication";
import {
  HASHLINE_PREFIX_RE,
  restoreLeadingIndent,
  stripInsertAnchorEcho,
  stripInsertBeforeEcho,
  stripInsertBoundaryEcho,
  stripLinePrefixes,
  stripRangeBoundaryEcho,
  toNewLines,
} from "../edit-text-normalization";
import { formatHashLine, formatHashLines } from "../hash-computation";
import { normalizeHashlineEdits } from "../normalize-edits";
import { HashlineMismatchError, normalizeLineRef, parseLineRef, validateLineRef, validateLineRefs } from "../validation";
import {
  autocorrectReplacementLines,
  maybeExpandSingleLineMerge,
  restoreIndentForPairedReplacement,
  restoreOldWrappedLines,
  stripMergeOperatorChars,
  stripTrailingContinuationTokens,
} from "../autocorrect-replacement-lines";
import { hashXxh32 } from "../xxhash32";
import type { HashlineEdit } from "../types";

function ref(lines: string[], line: number): string {
  return formatHashLine(line, lines[line - 1]!).split("|")[0]!;
}

describe("hashline text normalization", () => {
  it("strips hash prefixes by majority and keeps minority accidental prefixes", () => {
    expect(stripLinePrefixes([
      "1#ZZ|alpha",
      ">>> 2#ZZ|beta",
      "plain",
    ])).toEqual(["alpha", "beta", "plain"]);
    expect(HASHLINE_PREFIX_RE.test("  >> 12#ZZ|x")).toBe(true);
  });

  it("strips diff plus prefixes only when hash prefixes are not the majority", () => {
    expect(stripLinePrefixes(["+alpha", "+beta", "plain"])).toEqual(["alpha", "beta", "plain"]);
    expect(stripLinePrefixes(["+alpha", "plain", "other"])).toEqual(["+alpha", "plain", "other"]);
  });

  it("handles empty input, arrays, indentation, and echoed insertion anchors", () => {
    expect(stripLinePrefixes(["", ""])).toEqual(["", ""]);
    expect(toNewLines("a\n+b\nc")).toEqual(["a", "+b", "c"]);
    expect(restoreLeadingIndent("  old", "new")).toBe("  new");
    expect(restoreLeadingIndent("old", "new")).toBe("new");
    expect(restoreLeadingIndent("  old", "  new")).toBe("  new");
    expect(restoreLeadingIndent("  same", "same")).toBe("same");
    expect(stripInsertAnchorEcho("anchor", [" anchor ", "next"])).toEqual(["next"]);
    expect(stripInsertBeforeEcho("anchor", ["prev", "anchor"])).toEqual(["prev"]);
    expect(stripInsertBoundaryEcho("after", "before", [" after ", "body", " before "])).toEqual(["body"]);
  });

  it("strips range boundary echoes only when replacement is larger than replaced range", () => {
    const lines = ["before", "old-a", "old-b", "after"];
    expect(stripRangeBoundaryEcho(lines, 2, 3, ["before", "new-a", "new-b", "after"])).toEqual(["new-a", "new-b"]);
    expect(stripRangeBoundaryEcho(lines, 2, 3, ["new-a", "new-b"])).toEqual(["new-a", "new-b"]);
    expect(stripRangeBoundaryEcho(lines, 1, 2, ["new-a", "after"])).toEqual(["new-a", "after"]);
  });
});

describe("hashline edit primitives", () => {
  it("applies set, range, anchored insert, append, and prepend edits", () => {
    const lines = ["function x() {", "return 1;", "}"];
    expect(applySetLine(lines, ref(lines, 2), "return 2;")).toEqual(["function x() {", "return 2;", "}"]);
    expect(applyReplaceLines(lines, ref(lines, 1), ref(lines, 2), ["function y() {", "return 3;"])).toEqual([
      "function y() {",
      "return 3;",
      "}",
    ]);
    expect(applyInsertAfter(lines, ref(lines, 1), ["function x() {", "  const n = 1;"])).toEqual([
      "function x() {",
      "  const n = 1;",
      "return 1;",
      "}",
    ]);
    expect(applyInsertBefore(lines, ref(lines, 3), ["  done();", "}"])).toEqual([
      "function x() {",
      "return 1;",
      "  done();",
      "}",
    ]);
    expect(applyAppend([""], "tail")).toEqual(["tail"]);
    expect(applyAppend(["head"], "tail")).toEqual(["head", "tail"]);
    expect(applyPrepend([""], "head")).toEqual(["head"]);
    expect(applyPrepend(["tail"], "head")).toEqual(["head", "tail"]);
  });

  it("rejects invalid ranges and empty anchored insertions", () => {
    const lines = ["a", "b"];
    expect(() => applyReplaceLines(lines, ref(lines, 2), ref(lines, 1), "x")).toThrow(/Invalid range/);
    expect(() => applyInsertAfter(lines, ref(lines, 1), "a")).toThrow(/requires non-empty text/);
    expect(() => applyAppend([], [])).toThrow(/append requires/);
    expect(() => applyPrepend([], [])).toThrow(/prepend requires/);
  });
});

describe("hashline edit ordering and dedupe", () => {
  it("collects refs, computes line numbers, dedupes normalized edits, and detects overlap", () => {
    const lines = ["a", "b", "c"];
    const edits: HashlineEdit[] = [
      { op: "replace", pos: ref(lines, 1), end: ref(lines, 2), lines: ["x"] },
      { op: "append", pos: ref(lines, 3), lines: "+z" },
      { op: "prepend", lines: "start" },
    ];
    expect(getEditLineNumber(edits[0]!)).toBe(2);
    expect(getEditLineNumber(edits[1]!)).toBe(3);
    expect(getEditLineNumber(edits[2]!)).toBe(Number.NEGATIVE_INFINITY);
    expect(collectLineRefs(edits)).toEqual([ref(lines, 1), ref(lines, 2), ref(lines, 3)]);

    const deduped = dedupeEdits([edits[1]!, { op: "append", pos: `>>> ${ref(lines, 3)}|c`, lines: "z" }]);
    expect(deduped.edits).toHaveLength(1);
    expect(deduped.deduplicatedEdits).toBe(1);

    expect(detectOverlappingRanges([
      { op: "replace", pos: ref(lines, 1), end: ref(lines, 2), lines: "x" },
      { op: "replace", pos: ref(lines, 2), end: ref(lines, 3), lines: "y" },
    ])).toContain("Overlapping range edits");
    expect(detectOverlappingRanges([{ op: "append", lines: "x" }])).toBeNull();
  });
});

describe("hashline edit application", () => {
  it("sorts edits bottom-up, reports noops and deduped edits", () => {
    const content = "a\nb\nc";
    const lines = content.split("\n");
    const report = applyHashlineEditsWithReport(content, [
      { op: "prepend", pos: ref(lines, 1), lines: "top" },
      { op: "append", lines: "tail" },
      { op: "replace", pos: ref(lines, 2), lines: "b" },
      { op: "replace", pos: ref(lines, 2), lines: "b" },
    ]);
    expect(report.content).toBe("top\na\nb\nc\ntail");
    expect(report.noopEdits).toBe(1);
    expect(report.deduplicatedEdits).toBe(1);
  });

  it("returns unchanged report for empty edit list and validates refs before applying", () => {
    expect(applyHashlineEditsWithReport("a", [])).toEqual({ content: "a", noopEdits: 0, deduplicatedEdits: 0 });
    expect(() => applyHashlineEditsWithReport("a", [{ op: "append", pos: "99#ZZ", lines: "x" }])).toThrow(/out of bounds/);
  });
});

describe("hashline input normalization and validation", () => {
  it("normalizes raw edits and rejects malformed operations", () => {
    expect(normalizeHashlineEdits([
      { op: "replace", end: " 1#ZZ ", lines: null },
      { op: "append", end: "2#YY", lines: "x" },
      { op: "prepend", pos: " ", lines: ["y"] },
    ])).toEqual([
      { op: "replace", pos: "1#ZZ", end: "1#ZZ", lines: [] },
      { op: "append", pos: "2#YY", lines: "x" },
      { op: "prepend", lines: ["y"] },
    ]);
    expect(() => normalizeHashlineEdits([{ op: "replace", lines: "x" }])).toThrow(/requires at least one anchor/);
    expect(() => normalizeHashlineEdits([{ op: "append" }])).toThrow(/lines is required/);
    expect(() => normalizeHashlineEdits([{ op: "bad" as never, lines: "x" }])).toThrow(/unsupported op/);
  });

  it("normalizes, parses, validates, and reports hash mismatches with remaps", () => {
    const lines = ["alpha", "beta", "gamma"];
    expect(normalizeLineRef(`>>> ${ref(lines, 1)}|alpha`)).toBe(ref(lines, 1));
    expect(normalizeLineRef(`+ ${ref(lines, 2)}`)).toBe(ref(lines, 2));
    expect(normalizeLineRef(`noise ${ref(lines, 3)}`)).toBe(ref(lines, 3));
    expect(parseLineRef(ref(lines, 1))).toEqual({ line: 1, hash: ref(lines, 1).split("#")[1] });
    expect(() => parseLineRef("abc#ZZ")).toThrow(/not a line number/);
    expect(() => parseLineRef("bad")).toThrow(/Invalid line reference format/);

    expect(() => validateLineRef(lines, ref(lines, 1))).not.toThrow();
    expect(() => validateLineRef(lines, "9#ZZ")).toThrow(/out of bounds/);
    expect(() => validateLineRefs(lines, [ref(lines, 1), "2#ZZ"])).toThrow(HashlineMismatchError);
    try {
      validateLineRefs(lines, ["2#ZZ"]);
      throw new Error("expected mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(HashlineMismatchError);
      expect((error as HashlineMismatchError).remaps.get("2#ZZ")).toBe(ref(lines, 2));
      expect((error as Error).message).toContain("Use updated");
    }
  });

  it("formats hash lines for empty and non-empty content", () => {
    expect(formatHashLines("")).toBe("");
    expect(formatHashLines("a\nb")).toContain("1#");
  });
});

describe("hashline replacement autocorrect", () => {
  it("expands one-line merged replacements using ordered, fuzzy, and semicolon matching", () => {
    expect(maybeExpandSingleLineMerge(["const a = 1,", "b = 2"], ["const a = 1,b = 2"])).toEqual([
      "const a = 1,",
      "b = 2",
    ]);
    expect(maybeExpandSingleLineMerge(["foo &&", "bar"], ["foo bar"])).toEqual(["foo", "bar"]);
    expect(maybeExpandSingleLineMerge(["a();", "b()"], ["a(); b()"])).toEqual(["a();", "b()"]);
    expect(maybeExpandSingleLineMerge(["a", ""], ["a"])).toEqual(["a"]);
    expect(maybeExpandSingleLineMerge(["a"], ["a"])).toEqual(["a"]);
  });

  it("restores old wrapped lines only for unique spans", () => {
    expect(restoreOldWrappedLines(["const longCall = foo(bar);"], ["const longCall", "= foo(bar);"])).toEqual([
      "const longCall = foo(bar);",
    ]);
    expect(restoreOldWrappedLines(["dup", "dup"], ["d", "up"])).toEqual(["d", "up"]);
    expect(restoreOldWrappedLines([], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("restores paired indentation and leaves already-indented or identical lines alone", () => {
    expect(restoreIndentForPairedReplacement(["  old", "\tkeep"], ["new", "\tkeep"])).toEqual(["  new", "\tkeep"]);
    expect(restoreIndentForPairedReplacement(["  old"], ["  new"])).toEqual(["  new"]);
    expect(restoreIndentForPairedReplacement(["old"], ["new"])).toEqual(["new"]);
    expect(restoreIndentForPairedReplacement(["  a", "b"], ["x"])).toEqual(["x"]);
  });

  it("runs the full autocorrect pipeline and exposes token helpers", () => {
    expect(stripTrailingContinuationTokens("foo && ")).toBe("foo ");
    expect(stripTrailingContinuationTokens("foo")).toBe("foo");
    expect(stripMergeOperatorChars("a && b ? c")).toBe("a  b  c");
    expect(autocorrectReplacementLines(["  const a = 1;", "  const b = 2;"], ["const a = 1; const b = 2;"])).toEqual([
      "const a = 1;",
      "const b = 2;",
    ]);
  });
});

describe("hashline xxhash runtime selection", () => {
  it("uses the Bun native hash when available and JS fallback otherwise", () => {
    const originalBun = (globalThis as typeof globalThis & { Bun?: unknown }).Bun;
    try {
      delete (globalThis as typeof globalThis & { Bun?: unknown }).Bun;
      const fallback = hashXxh32("abc", 0);
      expect(fallback).toBeTypeOf("number");

      (globalThis as typeof globalThis & { Bun?: unknown }).Bun = {
        hash: {
          xxHash32: (input: string | Uint8Array, seed: number) => (String(input).length + seed + 123) >>> 0,
        },
      };
      expect(hashXxh32("abc", 7)).toBe(133);
    } finally {
      if (originalBun === undefined) {
        delete (globalThis as typeof globalThis & { Bun?: unknown }).Bun;
      } else {
        (globalThis as typeof globalThis & { Bun?: unknown }).Bun = originalBun;
      }
    }
  });
});
