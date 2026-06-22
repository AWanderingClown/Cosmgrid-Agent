// v0.7 增强-2 — git 只读工具单测
//
// 关键覆盖点：
//   1. operation 子命令白名单（status/diff/log）+ 参数构造（pathspec 在 -- 之后防注入）
//   2. path 越出 workspace / 命中敏感模式 → denied
//   3. adapter 返回非零退出码 → 把 stderr 当错误回给模型
//   4. 输出超长 → 截断到 GIT_READ_OUTPUT_LIMIT
//   5. 空 stdout → "(无输出：工作区干净或无匹配)"
//   6. adapter 抛异常 → 错误信息收敛

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../../db", () => ({
  toolExecutions: { create: vi.fn().mockResolvedValue("id") },
}));

import { gitReadTool, GIT_READ_OUTPUT_LIMIT } from "../git-read-tool";
import {
  setGitReadAdapter,
  type GitReadAdapter,
} from "../git-read-adapter";
import type { ToolContext } from "../types";

const ctx: ToolContext = { workspacePath: "/ws" };

let lastCall: { workspace: string; args: string[] } | null = null;
const adapter: GitReadAdapter = {
  run: async (workspace, args) => {
    lastCall = { workspace, args };
    return { stdout: "", stderr: "", code: 0 };
  },
};

beforeEach(() => {
  lastCall = null;
  setGitReadAdapter(adapter);
});

describe("git_read operation → 参数构造", () => {
  it("status 默认参数含 --short --branch", async () => {
    await gitReadTool.execute({ operation: "status" }, ctx);
    expect(lastCall?.args).toEqual(["status", "--short", "--branch"]);
  });

  it("diff 默认无 staged", async () => {
    await gitReadTool.execute({ operation: "diff" }, ctx);
    expect(lastCall?.args).toEqual(["diff"]);
  });

  it("diff + staged=true 加 --staged", async () => {
    await gitReadTool.execute({ operation: "diff", staged: true }, ctx);
    expect(lastCall?.args).toEqual(["diff", "--staged"]);
  });

  it("log 默认 20 条 + --oneline", async () => {
    await gitReadTool.execute({ operation: "log" }, ctx);
    expect(lastCall?.args).toEqual(["log", "--oneline", "-n", "20"]);
  });

  it("log + maxCount=5 用 5", async () => {
    await gitReadTool.execute({ operation: "log", maxCount: 5 }, ctx);
    expect(lastCall?.args).toEqual(["log", "--oneline", "-n", "5"]);
  });

  it("pathspec 一律放在 -- 之后（防参数注入）", async () => {
    await gitReadTool.execute({ operation: "status", path: "src/a.ts" }, ctx);
    expect(lastCall?.args).toEqual(["status", "--short", "--branch", "--", "/ws/src/a.ts"]);
  });
});

describe("git_read path 校验", () => {
  it("path 越出 workspace → denied", async () => {
    const res = await gitReadTool.execute(
      { operation: "status", path: "../../etc/passwd" },
      ctx,
    );
    expect(res.status).toBe("denied");
    expect(res.output).toContain("越出工作区");
    expect(lastCall).toBeNull();
  });

  it("path 命中敏感路径（.ssh）→ denied", async () => {
    const res = await gitReadTool.execute({ operation: "log", path: ".ssh/id_rsa" }, ctx);
    expect(res.status).toBe("denied");
    expect(res.output).toContain("敏感路径");
    expect(lastCall).toBeNull();
  });

  it("path 空字符串 → 当作未指定", async () => {
    await gitReadTool.execute({ operation: "status", path: "  " }, ctx);
    expect(lastCall?.args).toEqual(["status", "--short", "--branch"]);
  });
});

describe("git_read adapter 结果处理", () => {
  it("非零退出码 + stderr 非空 → status=error 含 stderr", async () => {
    setGitReadAdapter({
      run: async () => ({ stdout: "", stderr: "not a git repository", code: 128 }),
    });
    const res = await gitReadTool.execute({ operation: "status" }, ctx);
    expect(res.status).toBe("error");
    expect(res.output).toContain("not a git repository");
  });

  it("非零退出码 + stderr 空 → status=error 含退出码", async () => {
    setGitReadAdapter({
      run: async () => ({ stdout: "", stderr: "", code: 128 }),
    });
    const res = await gitReadTool.execute({ operation: "diff" }, ctx);
    expect(res.status).toBe("error");
    expect(res.output).toContain("128");
  });

  it("退出码为 0 + stdout 为空 → '(无输出)'", async () => {
    setGitReadAdapter({
      run: async () => ({ stdout: "", stderr: "", code: 0 }),
    });
    const res = await gitReadTool.execute({ operation: "status" }, ctx);
    expect(res.status).toBe("success");
    expect(res.output).toContain("无输出");
  });

  it("退出码为 0 + stdout 有内容 → 原文返回", async () => {
    setGitReadAdapter({
      run: async () => ({ stdout: " M src/a.ts\n", stderr: "", code: 0 }),
    });
    const res = await gitReadTool.execute({ operation: "status" }, ctx);
    expect(res.status).toBe("success");
    expect(res.output).toBe("M src/a.ts");
  });

  it("输出超长 → 截断到 GIT_READ_OUTPUT_LIMIT + 提示", async () => {
    const huge = "x".repeat(GIT_READ_OUTPUT_LIMIT + 100);
    setGitReadAdapter({
      run: async () => ({ stdout: huge, stderr: "", code: 0 }),
    });
    const res = await gitReadTool.execute({ operation: "diff" }, ctx);
    expect(res.status).toBe("success");
    // 锁死契约：截断 = 原文前 N 字符（不能改成别的截断长度）
    expect(res.output.startsWith("x".repeat(GIT_READ_OUTPUT_LIMIT))).toBe(true);
    expect(res.output.endsWith("…(截断)")).toBe(true);
  });

  it("adapter 抛错 → status=error 含异常消息", async () => {
    setGitReadAdapter({
      run: async () => {
        throw new Error("Tauri invoke failed");
      },
    });
    const res = await gitReadTool.execute({ operation: "log" }, ctx);
    expect(res.status).toBe("error");
    expect(res.output).toContain("Tauri invoke failed");
  });
});

describe("git_read schema 约束", () => {
  it("maxCount 超 100 被 zod 拒掉", () => {
    const r = gitReadTool.parameters.safeParse({ operation: "log", maxCount: 200 });
    expect(r.success).toBe(false);
  });

  it("operation 不是 status/diff/log 被 zod 拒掉", () => {
    const r = gitReadTool.parameters.safeParse({ operation: "push" });
    expect(r.success).toBe(false);
  });
});