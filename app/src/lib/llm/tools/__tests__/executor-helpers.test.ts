import { describe, expect, it } from "vitest";
import { z } from "zod";
import { maybeBuildDoomLoopResult } from "../executor-doom-loop";
import { summarizePartsForAudit } from "../executor-parts-audit";
import { renderResultForModel } from "../executor-render";
import { normalizeToV2 } from "../executor-result";
import { runSecurityPrecheck } from "../executor-security";
import { safeStringify, shapeOfInput } from "../executor-serialization";
import type { AnyToolDefinition, ToolContext } from "../types";

const baseCtx: ToolContext = {
  workspacePath: "/tmp/cosmgrid-test",
  projectId: "p1",
  conversationId: "c1",
};

function toolWithSecurity(security: AnyToolDefinition["security"]): AnyToolDefinition {
  return {
    name: "helper_tool",
    description: "helper",
    parameters: z.object({}),
    readOnly: true,
    security,
    execute: async () => ({
      status: "success",
      summary: "ok",
      output: "ok",
      artifacts: [],
      nextActions: [],
    }),
  };
}

describe("executor helper coverage", () => {
  it("safeStringify handles plain values, bigint, and unserializable circular objects", () => {
    expect(safeStringify({ a: 1 })).toBe('{"a":1}');
    expect(safeStringify({ n: 1n })).toBe('{"n":"1"}');

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(safeStringify(circular)).toBe("[object Object]");
  });

  it("shapeOfInput returns compact json, truncates long json, and handles circular objects", () => {
    expect(shapeOfInput({ a: 1 })).toBe('{"a":1}');
    expect(shapeOfInput({ text: "x".repeat(260) })).toContain("…(truncated)");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(shapeOfInput(circular)).toBe("(unserializable)");
  });

  it("summarizePartsForAudit supports raw base64 image strings without data-url prefix", () => {
    const out = summarizePartsForAudit([
      { type: "image", image: "A".repeat(1368), mediaType: "image/webp" },
    ]);
    expect(out).toContain("[image webp");
    expect(out).toContain("1.0KB]");
  });

  it("normalizeToV2 accepts valid v2 results and falls back for legacy results", () => {
    const warning = {
      status: "warning" as const,
      summary: "warn",
      output: "warn",
      artifacts: [],
      nextActions: [],
    };
    expect(normalizeToV2(warning)).toBe(warning);

    const legacy = normalizeToV2({ status: "success", output: "legacy ok" });
    expect(legacy.summary).toBe("legacy ok");
    expect(legacy.artifacts).toEqual([]);
  });

  it("renderResultForModel covers unsafe actions and artifacts without labels", () => {
    const rendered = renderResultForModel(
      {
        status: "success",
        summary: "ok",
        output: "done",
        artifacts: [{ kind: "file", uri: "src/a.ts", label: "" }],
        nextActions: [{ action: "write_file", reason: "needs edit", safe: false }],
      },
      100,
    );
    expect(rendered).toContain("write_file (需用户确认): needs edit");
    expect(rendered).toContain("[artifacts] file:src/a.ts");
  });

  it("runSecurityPrecheck returns undefined security for missing optional fields", async () => {
    await expect(
      runSecurityPrecheck(toolWithSecurity({ kind: "read-path", pathField: "file_path" }), {}, baseCtx),
    ).resolves.toEqual({ security: undefined });
    await expect(
      runSecurityPrecheck(toolWithSecurity({ kind: "write-path", pathField: "file_path" }), { file_path: " " }, baseCtx),
    ).resolves.toEqual({ security: undefined });
    await expect(
      runSecurityPrecheck(toolWithSecurity({ kind: "command", commandField: "command" }), {}, baseCtx),
    ).resolves.toEqual({ security: undefined });
    await expect(runSecurityPrecheck(toolWithSecurity({ kind: "none" }), {}, baseCtx)).resolves.toEqual({
      security: undefined,
    });
  });

  it("runSecurityPrecheck returns command verdicts and denied command blocks", async () => {
    await expect(
      runSecurityPrecheck(
        toolWithSecurity({ kind: "command", commandField: "command" }),
        { command: "ls -la" },
        baseCtx,
      ),
    ).resolves.toMatchObject({ security: { kind: "command" } });

    const denied = await runSecurityPrecheck(
      toolWithSecurity({ kind: "command", commandField: "command" }),
      { command: "rm -rf /" },
      baseCtx,
    );
    expect("denied" in denied).toBe(true);
  });

  it("maybeBuildDoomLoopResult returns null before threshold and error after repeated calls", () => {
    const ctx = { ...baseCtx, messageId: "helper-doom-loop" };
    expect(maybeBuildDoomLoopResult(ctx, "read", { file_path: "a.ts" }, '{"file_path":"a.ts"}')).toBeNull();
    expect(maybeBuildDoomLoopResult(ctx, "read", { file_path: "a.ts" }, '{"file_path":"a.ts"}')).toBeNull();

    const third = maybeBuildDoomLoopResult(ctx, "read", { file_path: "a.ts" }, '{"file_path":"a.ts"}');
    expect(third?.error?.code).toBe("TOOL_DOOM_LOOP");
    expect(third?.nextActions.map((a) => a.action)).toContain("ask_user");
  });
});
