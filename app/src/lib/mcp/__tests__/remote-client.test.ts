import { describe, expect, it, vi } from "vitest";
import { listAllRemoteTools } from "../remote-client";

describe("listAllRemoteTools", () => {
  it("follows MCP cursors until all tools are collected", async () => {
    const listTools = vi.fn()
      .mockResolvedValueOnce({
        tools: [{ name: "first", inputSchema: { type: "object" } }],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        tools: [{ name: "second", inputSchema: { type: "object" } }],
      });

    await expect(listAllRemoteTools({ listTools })).resolves.toEqual([
      { name: "first", inputSchema: { type: "object" } },
      { name: "second", inputSchema: { type: "object" } },
    ]);
    expect(listTools).toHaveBeenNthCalledWith(1, undefined);
    expect(listTools).toHaveBeenNthCalledWith(2, { cursor: "page-2" });
  });

  it("stops if a broken server repeats the same cursor", async () => {
    const listTools = vi.fn()
      .mockResolvedValueOnce({ tools: [], nextCursor: "same" })
      .mockResolvedValueOnce({ tools: [], nextCursor: "same" });

    await expect(listAllRemoteTools({ listTools })).rejects.toThrow("repeated cursor");
  });
});
