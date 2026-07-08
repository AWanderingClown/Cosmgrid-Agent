import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildMcpToolDefinitions, jsonSchemaToZod } from "../mcp-tool-adapter";

describe("jsonSchemaToZod", () => {
  it("converts common MCP object schemas to zod", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      required: ["owner", "repo"],
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        limit: { type: "number" },
        state: { type: "string", enum: ["open", "closed"] },
      },
    });

    expect(schema.parse({ owner: "o", repo: "r", state: "open" })).toEqual({ owner: "o", repo: "r", state: "open" });
    expect(() => schema.parse({ owner: "o" })).toThrow(z.ZodError);
    expect(() => schema.parse({ owner: "o", repo: "r", state: "bad" })).toThrow(z.ZodError);
  });

  it("covers arrays, booleans, integers, nullable types, and unknown fallbacks", () => {
    expect(jsonSchemaToZod({ type: "boolean" }).parse(true)).toBe(true);
    expect(jsonSchemaToZod({ type: "integer" }).parse(2)).toBe(2);
    expect(() => jsonSchemaToZod({ type: "integer" }).parse(2.5)).toThrow();
    expect(jsonSchemaToZod({ type: "array", items: { type: "string" } }).parse(["a"])).toEqual(["a"]);
    expect(jsonSchemaToZod({ type: ["null", "number"] }).parse(3)).toBe(3);
    expect(jsonSchemaToZod({ type: "unsupported" }).parse({ anything: true })).toEqual({ anything: true });
    expect(jsonSchemaToZod(null).parse({ anything: true })).toEqual({ anything: true });
    expect(() => jsonSchemaToZod({ enum: [] }).parse("x")).toThrow();
    expect(jsonSchemaToZod({ enum: ["a", 1] }).parse("anything")).toBe("anything");
  });
});

describe("buildMcpToolDefinitions", () => {
  it("prefixes MCP tools and treats them as confirm-required by default", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "created" }] }));
    const [tool] = buildMcpToolDefinitions({
      serverId: "github",
      tools: [{
        name: "create_issue",
        description: "Create issue",
        inputSchema: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
      }],
      callTool,
    });

    expect(tool?.name).toBe("mcp__github__create_issue");
    expect(tool?.readOnly).toBe(false);

    await expect(tool!.execute({ title: "Bug" }, {
      workspacePath: "/repo",
      confirm: async () => false,
    })).resolves.toMatchObject({ status: "denied" });

    await expect(tool!.execute({ title: "Bug" }, {
      workspacePath: "/repo",
      confirm: async () => true,
    })).resolves.toMatchObject({ status: "success", output: "created" });
    expect(callTool).toHaveBeenCalledWith("create_issue", { title: "Bug" });
  });

  it("deduplicates tool names that collide after sanitization", () => {
    const tools = buildMcpToolDefinitions({
      serverId: "server",
      tools: [
        { name: "read:file", inputSchema: { type: "object" } },
        { name: "read file", inputSchema: { type: "object" } },
      ],
      callTool: vi.fn(),
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "mcp__server__read_file",
      "mcp__server__read_file_2",
    ]);
  });

  it("handles empty sanitized names, missing confirmation, errors, and non-text results", async () => {
    const callTool = vi.fn()
      .mockResolvedValueOnce({ isError: true, content: [{ type: "image", data: "x" }] })
      .mockResolvedValueOnce({ extra: "fallback" });
    const [tool] = buildMcpToolDefinitions({
      serverId: "***",
      tools: [{ name: "!!!", inputSchema: {} }],
      callTool,
    });
    expect(tool?.name).toBe("mcp__server__tool");
    expect(tool?.description).toContain("MCP tool");
    await expect(tool!.execute({}, { workspacePath: "/repo" })).resolves.toMatchObject({ status: "denied" });
    await expect(tool!.execute({}, { workspacePath: "/repo", confirm: async () => true }))
      .resolves.toMatchObject({ status: "error", output: expect.stringContaining("image") });
    await expect(tool!.execute({}, { workspacePath: "/repo", confirm: async () => true }))
      .resolves.toMatchObject({ status: "success", output: '{"extra":"fallback"}' });
  });
});
