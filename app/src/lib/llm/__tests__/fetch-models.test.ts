import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchAvailableModels } from "../fetch-models";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function errStatus(status: number) {
  return { ok: false, status, json: async () => ({}) };
}

describe("fetchAvailableModels", () => {
  it("openai-compatible：GET {base}/models + Bearer，解析 data[].id", async () => {
    fetchMock.mockResolvedValue(okJson({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }));
    const r = await fetchAvailableModels({ providerType: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKey: "sk-x" });
    expect(r.ok).toBe(true);
    expect(r.models).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/models");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-x");
  });

  it("base URL 末尾斜杠会被规整", async () => {
    fetchMock.mockResolvedValue(okJson({ data: [{ id: "m" }] }));
    await fetchAvailableModels({ providerType: "openai-compatible", baseUrl: "https://api.deepseek.com/", apiKey: "k" });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.deepseek.com/models");
  });

  it("anthropic：用 x-api-key + anthropic-version，路径 /v1/models", async () => {
    fetchMock.mockResolvedValue(okJson({ data: [{ id: "claude-opus-4-8" }] }));
    const r = await fetchAvailableModels({ providerType: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant" });
    expect(r.models).toEqual(["claude-opus-4-8"]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/models");
    const h = init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe("sk-ant");
    expect(h["anthropic-version"]).toBeTruthy();
  });

  it("google：key 走 query，解析 models[].name 并剥 models/ 前缀", async () => {
    fetchMock.mockResolvedValue(okJson({ models: [{ name: "models/gemini-2.5-pro" }, { name: "models/gemini-2.5-flash" }] }));
    const r = await fetchAvailableModels({ providerType: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "AIza" });
    expect(r.models).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]); // 排序后
    expect(fetchMock.mock.calls[0]![0]).toContain("/models?key=AIza");
  });

  it("过滤掉明显的非对话模型（embedding/whisper 等）", async () => {
    fetchMock.mockResolvedValue(okJson({ data: [{ id: "gpt-4o" }, { id: "text-embedding-3-large" }, { id: "whisper-1" }] }));
    const r = await fetchAvailableModels({ providerType: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk" });
    expect(r.models).toEqual(["gpt-4o"]);
  });

  it("401 → unauthorized", async () => {
    fetchMock.mockResolvedValue(errStatus(401));
    const r = await fetchAvailableModels({ providerType: "openai-compatible", baseUrl: "https://x.com/v1", apiKey: "bad" });
    expect(r.ok).toBe(false);
    expect(r.errorKey).toBe("unauthorized");
    expect(r.status).toBe(401);
  });

  it("404 → notFound", async () => {
    fetchMock.mockResolvedValue(errStatus(404));
    const r = await fetchAvailableModels({ providerType: "openai-compatible", baseUrl: "https://x.com/v1", apiKey: "k" });
    expect(r.errorKey).toBe("notFound");
  });

  it("CLI 类型不支持拉取", async () => {
    const r = await fetchAvailableModels({ providerType: "claude-cli", baseUrl: "", apiKey: "" });
    expect(r.ok).toBe(false);
    expect(r.errorKey).toBe("unsupported");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("缺 baseUrl / key 时给明确 errorKey", async () => {
    expect((await fetchAvailableModels({ providerType: "openai", baseUrl: "", apiKey: "k" })).errorKey).toBe("noBaseUrl");
    expect((await fetchAvailableModels({ providerType: "openai", baseUrl: "https://x/v1", apiKey: "" })).errorKey).toBe("noKey");
  });

  it("网络异常 → network；超时 → timeout", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    expect((await fetchAvailableModels({ providerType: "openai", baseUrl: "https://x/v1", apiKey: "k" })).errorKey).toBe("network");
    const timeoutErr = new Error("t"); timeoutErr.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeoutErr);
    expect((await fetchAvailableModels({ providerType: "openai", baseUrl: "https://x/v1", apiKey: "k" })).errorKey).toBe("timeout");
  });

  it("返回空列表 → empty", async () => {
    fetchMock.mockResolvedValue(okJson({ data: [] }));
    expect((await fetchAvailableModels({ providerType: "openai", baseUrl: "https://x/v1", apiKey: "k" })).errorKey).toBe("empty");
  });
});
