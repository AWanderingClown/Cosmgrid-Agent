import { describe, expect, it, vi, afterEach } from "vitest";
import { disposeBackgroundSessionsForClose } from "../app-close";

vi.mock("../lsp/lsp-session", () => ({
  disposeLspSessions: vi.fn(async () => undefined),
}));

vi.mock("../mcp/client", () => ({
  disposeAllMcpSessions: vi.fn(async () => undefined),
}));

describe("disposeBackgroundSessionsForClose", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns completed when background sessions dispose promptly", async () => {
    await expect(disposeBackgroundSessionsForClose({
      timeoutMs: 100,
      disposeLsp: async () => undefined,
      disposeMcp: async () => undefined,
    })).resolves.toBe("completed");
  });

  it("times out instead of blocking window close forever", async () => {
    vi.useFakeTimers();
    const pending = new Promise<void>(() => undefined);

    const result = disposeBackgroundSessionsForClose({
      timeoutMs: 100,
      disposeLsp: () => pending,
      disposeMcp: async () => undefined,
    });

    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBe("timed_out");
  });
});
