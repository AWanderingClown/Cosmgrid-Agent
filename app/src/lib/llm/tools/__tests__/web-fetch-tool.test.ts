import { describe, it, expect, vi, afterEach } from "vitest";
import { assertSafeUrl, webFetchTool } from "../web-fetch-tool";
import type { ToolContext } from "../types";

const ctx: ToolContext = { workspacePath: "" };

describe("assertSafeUrl", () => {
  it("放行普通公网 URL", () => {
    expect(assertSafeUrl("https://okx.ai/foo").ok).toBe(true);
  });
  it("拒绝非 http/https 协议", () => {
    const r = assertSafeUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
  });
  it("拒绝 localhost", () => {
    expect(assertSafeUrl("http://localhost:1420/").ok).toBe(false);
  });
  it("拒绝 127.0.0.1 回环", () => {
    expect(assertSafeUrl("http://127.0.0.1:8080/").ok).toBe(false);
  });
  it("拒绝 10.x 内网段", () => {
    expect(assertSafeUrl("http://10.0.0.5/").ok).toBe(false);
  });
  it("拒绝 192.168.x 内网段", () => {
    expect(assertSafeUrl("http://192.168.1.1/").ok).toBe(false);
  });
  it("拒绝 172.16-31.x 内网段", () => {
    expect(assertSafeUrl("http://172.20.0.1/").ok).toBe(false);
    expect(assertSafeUrl("http://172.15.0.1/").ok).toBe(true); // 172.15 不在 16-31 范围
  });
  it("拒绝云 metadata 端点 169.254.169.254", () => {
    expect(assertSafeUrl("http://169.254.169.254/latest/meta-data/").ok).toBe(false);
  });
  it("拒绝畸形 URL", () => {
    expect(assertSafeUrl("not a url").ok).toBe(false);
  });
});

describe("webFetchTool", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("内网 URL 直接 denied，不发起真实请求", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const res = await webFetchTool.execute({ url: "http://127.0.0.1/" }, ctx);
    expect(res.status).toBe("denied");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("成功抓取时把 html 转成纯文本并截断超长内容", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "text/html" },
      text: async () => "<html><body><script>evil()</script><p>hello world</p></body></html>",
    }) as unknown as typeof fetch;
    const res = await webFetchTool.execute({ url: "https://example.com/" }, ctx);
    expect(res.status).toBe("success");
    expect(res.output).toContain("hello world");
    expect(res.output).not.toContain("evil()");
  });

  it("请求失败返回 error 状态", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const res = await webFetchTool.execute({ url: "https://example.com/" }, ctx);
    expect(res.status).toBe("error");
    expect(res.output).toContain("network down");
  });
});
