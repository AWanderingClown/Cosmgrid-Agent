import { describe, it, expect, vi, afterEach } from "vitest";

const getApiKeyMock = vi.fn();
vi.mock("@/lib/keystore", () => ({
  getApiKey: (...args: unknown[]) => getApiKeyMock(...args),
}));

import { webSearchTool, TAVILY_SEARCH_CREDENTIAL_ID } from "../web-search-tool";
import type { ToolContext } from "../types";

const ctx: ToolContext = { workspacePath: "" };

describe("webSearchTool", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    getApiKeyMock.mockReset();
  });

  it("未配置 API Key 时 denied，不发起请求", async () => {
    getApiKeyMock.mockResolvedValue(null);
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const res = await webSearchTool.execute({ query: "test" }, ctx);
    expect(res.status).toBe("denied");
    expect(res.output).toContain("Tavily");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("用配置好的 key 取到 credentialId 对应的值并调用 Tavily", async () => {
    getApiKeyMock.mockResolvedValue("test-key");
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: "标题", url: "https://a.com", content: "摘要内容" }],
      }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;
    const res = await webSearchTool.execute({ query: "okx.ai 是什么" }, ctx);
    expect(getApiKeyMock).toHaveBeenCalledWith(TAVILY_SEARCH_CREDENTIAL_ID);
    expect(res.status).toBe("success");
    expect(res.output).toContain("标题");
    expect(res.output).toContain("https://a.com");
    expect(res.output).toContain("摘要内容");
  });

  it("无结果时给出明确提示而非空字符串", async () => {
    getApiKeyMock.mockResolvedValue("test-key");
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) }) as unknown as typeof fetch;
    const res = await webSearchTool.execute({ query: "xyz" }, ctx);
    expect(res.status).toBe("success");
    expect(res.output).toContain("没有搜到");
  });

  it("HTTP 非 200 返回 error", async () => {
    getApiKeyMock.mockResolvedValue("test-key");
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch;
    const res = await webSearchTool.execute({ query: "x" }, ctx);
    expect(res.status).toBe("error");
    expect(res.output).toContain("401");
  });

  it("请求异常返回 error", async () => {
    getApiKeyMock.mockResolvedValue("test-key");
    global.fetch = vi.fn().mockRejectedValue(new Error("boom")) as unknown as typeof fetch;
    const res = await webSearchTool.execute({ query: "x" }, ctx);
    expect(res.status).toBe("error");
    expect(res.output).toContain("boom");
  });
});
