import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

import { assertSafeUrl, webFetchTool } from "../web-fetch-tool";
import type { ToolContext } from "../types";

const ctx: ToolContext = { workspacePath: "" };

/** 凑够 Tier 1 "看起来完整"所需的最短长度（>200 字符），避免误触发 Tier 3 兜底 */
const LONG_TEXT = "hello world. ".repeat(20);

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
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("内网 URL 直接 denied，不发起真实请求", async () => {
    const res = await webFetchTool.execute({ url: "http://127.0.0.1/" }, ctx);
    expect(res.status).toBe("denied");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("Tier 1 拿到足量内容时直接成功，不会去尝试 Tier 3 渲染", async () => {
    mocks.invoke.mockResolvedValue({
      status: 200,
      finalUrl: "https://example.com/",
      contentType: "text/html",
      body: `<html><body><script>evil()</script><p>${LONG_TEXT}</p></body></html>`,
    });
    const res = await webFetchTool.execute({ url: "https://example.com/" }, ctx);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("fetch_url_backend", { url: "https://example.com/" });
    expect(res.status).toBe("success");
    expect(res.output).toContain("hello world");
    expect(res.output).not.toContain("evil()");
  });

  it("Tier 1 内容太短（看起来是个空壳）时自动退到 Tier 3 真实渲染", async () => {
    mocks.invoke.mockResolvedValueOnce({
      status: 200,
      finalUrl: "https://spa.example.com/",
      contentType: "text/html",
      body: "<html><body><div id=\"root\"></div></body></html>",
    });
    mocks.invoke.mockResolvedValueOnce({
      status: 200,
      finalUrl: "https://spa.example.com/",
      contentType: "text/plain",
      body: LONG_TEXT,
    });
    const res = await webFetchTool.execute({ url: "https://spa.example.com/" }, ctx);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "fetch_url_backend", { url: "https://spa.example.com/" });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "fetch_url_rendered", { url: "https://spa.example.com/" });
    expect(res.status).toBe("success");
    expect(res.output).toContain("hello world");
  });

  it("Tier 1 命中反爬挑战页文案时也会退到 Tier 3", async () => {
    mocks.invoke.mockResolvedValueOnce({
      status: 200,
      finalUrl: "https://protected.example.com/",
      contentType: "text/html",
      body: `<html><body>${"Checking your browser before accessing. ".repeat(10)}</body></html>`,
    });
    mocks.invoke.mockResolvedValueOnce({
      status: 200,
      finalUrl: "https://protected.example.com/",
      contentType: "text/plain",
      body: LONG_TEXT,
    });
    const res = await webFetchTool.execute({ url: "https://protected.example.com/" }, ctx);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(res.status).toBe("success");
  });

  it("Tier 1 直接抛错时退到 Tier 3，Tier 3 成功就用它的结果", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("network down"));
    mocks.invoke.mockResolvedValueOnce({
      status: 200,
      finalUrl: "https://example.com/",
      contentType: "text/plain",
      body: LONG_TEXT,
    });
    const res = await webFetchTool.execute({ url: "https://example.com/" }, ctx);
    expect(res.status).toBe("success");
    expect(res.output).toContain("hello world");
  });

  it("两档都失败，但 Tier 1 好歹拿到点内容时，宁可把它给出去也不空手而归", async () => {
    mocks.invoke.mockResolvedValueOnce({
      status: 200,
      finalUrl: "https://spa.example.com/",
      contentType: "text/html",
      body: "<html><body><p>Loading...</p></body></html>", // 太短，会判定为不完整
    });
    mocks.invoke.mockRejectedValueOnce(new Error("渲染超时"));
    const res = await webFetchTool.execute({ url: "https://spa.example.com/" }, ctx);
    expect(res.status).toBe("success");
    expect(res.output).toContain("Loading...");
  });

  it("两档都彻底失败时返回 error，说明两种方式都试过了", async () => {
    mocks.invoke.mockRejectedValue(new Error("network down"));
    const res = await webFetchTool.execute({ url: "https://example.com/" }, ctx);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(res.status).toBe("error");
    expect(res.output).toContain("network down");
  });
});
