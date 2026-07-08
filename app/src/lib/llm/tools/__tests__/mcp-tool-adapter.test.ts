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
});
