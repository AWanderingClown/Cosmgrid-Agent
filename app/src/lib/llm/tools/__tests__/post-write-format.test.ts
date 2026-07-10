// post-write-format 单测（L6 安全网收拢方案第四节，2026-07-09；2026-07-10 改走 runArgs 防 shell 注入）
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setShellAdapter, type ShellAdapter } from "../shell-adapter";
import { runPostWriteFormatter } from "../post-write-format";

let runArgsSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  runArgsSpy = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
  setShellAdapter({
    run: vi.fn(),
    runArgs: runArgsSpy,
  } as unknown as ShellAdapter);
});

describe("runPostWriteFormatter", () => {
  it.each([".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".md"])(
    "%s 文件用 npx prettier --write",
    async (ext) => {
      await runPostWriteFormatter(`/ws/src/file${ext}`);
      expect(runArgsSpy).toHaveBeenCalledWith(["npx", "prettier", "--write", `/ws/src/file${ext}`], ".");
    },
  );

  it(".rs 文件用 rustfmt", async () => {
    await runPostWriteFormatter("/ws/src/lib.rs");
    expect(runArgsSpy).toHaveBeenCalledWith(["rustfmt", "/ws/src/lib.rs"], ".");
  });

  it("不支持的扩展名（如 .png）不触发任何命令", async () => {
    await runPostWriteFormatter("/ws/assets/logo.png");
    expect(runArgsSpy).not.toHaveBeenCalled();
  });

  it("没有扩展名的文件不触发任何命令", async () => {
    await runPostWriteFormatter("/ws/Makefile");
    expect(runArgsSpy).not.toHaveBeenCalled();
  });

  it("格式化工具报错时静默吞掉，不抛出（best-effort，不能让格式化失败影响写操作结果）", async () => {
    setShellAdapter({
      run: vi.fn(),
      runArgs: vi.fn().mockRejectedValue(new Error("prettier not found")),
    } as unknown as ShellAdapter);
    await expect(runPostWriteFormatter("/ws/src/file.ts")).resolves.toBeUndefined();
  });

  it("扩展名大小写不敏感（.TS 也能识别）", async () => {
    await runPostWriteFormatter("/ws/src/FILE.TS");
    expect(runArgsSpy).toHaveBeenCalledWith(["npx", "prettier", "--write", "/ws/src/FILE.TS"], ".");
  });

  // 关键：绝对路径里带 shell 元字符时不能被 shell 解释成第二条命令。
  // 之前的字符串拼接（`npx prettier --write "${absPath}"`）会触发 shell 注入，
  // 走 runArgs（不经 sh）后，每个文件名都是独立 argv 元素，shell 不会拆解。
  it("文件路径含 ; && | 元字符时不会触发 shell 注入（参数化执行）", async () => {
    await runPostWriteFormatter('/ws/src/evil"; touch /tmp/pwned; #.ts');
    expect(runArgsSpy).toHaveBeenCalledWith(
      ["npx", "prettier", "--write", '/ws/src/evil"; touch /tmp/pwned; #.ts'],
      ".",
    );
    // 决不能调原来的字符串 run 接口
    const adapter = (await import("../shell-adapter")).getShellAdapter();
    expect((adapter.run as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
