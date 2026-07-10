import { describe, expect, it } from "vitest";
import { cn, formatCost } from "../utils";

describe("cn", () => {
  it("returns empty string when called with no arguments", () => {
    expect(cn()).toBe("");
  });

  it("returns a single class unchanged", () => {
    expect(cn("foo")).toBe("foo");
  });

  it("joins multiple string arguments with a space", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("trims surrounding whitespace and collapses repeats", () => {
    // clsx trims and collapses whitespace; final string is deduplicated whitespace.
    expect(cn("  foo  ", "bar")).toBe("foo bar");
  });

  it("ignores falsy conditional class objects", () => {
    expect(cn("base", { active: false, disabled: false })).toBe("base");
  });

  it("keeps truthy conditional class objects", () => {
    expect(cn("base", { active: true, disabled: false })).toBe(
      "base active",
    );
  });

  it("flattens array inputs", () => {
    expect(cn(["foo", "bar"])).toBe("foo bar");
  });

  it("flattens nested array inputs", () => {
    expect(cn(["foo", ["bar", "baz"]])).toBe("foo bar baz");
  });

  it("ignores undefined and null values", () => {
    expect(cn("foo", undefined, null, "bar")).toBe("foo bar");
  });

  it("ignores empty strings and zero", () => {
    expect(cn("foo", "", 0, false, "bar")).toBe("foo bar");
  });

  it("resolves tailwind class conflicts via twMerge (later wins)", () => {
    // px-2 conflicts with px-4 — twMerge keeps the last one.
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("resolves tailwind color conflicts", () => {
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("preserves non-conflicting tailwind classes", () => {
    expect(cn("px-2", "py-4", "text-red-500")).toBe(
      "px-2 py-4 text-red-500",
    );
  });

  it("handles mixed strings, arrays, objects, and falsy values together", () => {
    expect(
      cn("foo", ["bar"], { baz: true, qux: false }, undefined, null),
    ).toBe("foo bar baz");
  });
});

describe("formatCost", () => {
  it("formats zero with 4 decimals (n < 1 branch)", () => {
    expect(formatCost(0)).toBe("$0.0000");
  });

  it("formats small positive numbers with 4 decimals", () => {
    expect(formatCost(0.5)).toBe("$0.5000");
    expect(formatCost(0.0001)).toBe("$0.0001");
    expect(formatCost(0.9999)).toBe("$0.9999");
  });

  it("rounds small numbers to 4 decimals", () => {
    expect(formatCost(0.12345)).toBe("$0.1235");
  });

  it("uses 2 decimals for n >= 1 (large branch)", () => {
    expect(formatCost(1)).toBe("$1.00");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(100)).toBe("$100.00");
    expect(formatCost(1234.5678)).toBe("$1234.57");
  });

  it("formats a boundary value just below 1 with 4 decimals", () => {
    expect(formatCost(0.99999)).toBe("$1.0000");
  });

  it("formats a boundary value exactly 1 with 2 decimals", () => {
    expect(formatCost(1)).toBe("$1.00");
  });

  it("handles negative numbers with 4 decimals (n < 1 branch)", () => {
    expect(formatCost(-0.5)).toBe("$-0.5000");
  });

  it("handles negative numbers with 4 decimals (n < 1 is true for negatives)", () => {
    // -1.25 < 1 is true, so 4-decimal branch fires (current implementation behavior).
    expect(formatCost(-1.25)).toBe("$-1.2500");
  });

  it("formats very large numbers with 2 decimals", () => {
    expect(formatCost(99999.999)).toBe("$100000.00");
  });
});