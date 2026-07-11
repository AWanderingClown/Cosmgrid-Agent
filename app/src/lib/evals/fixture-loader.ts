// Harness 工程实施计划 阶段4 — Fixture loader。
//
// `loadEvalCase(filePath)`：读 JSON + zod 校验 EvalCase schema，失败时抛具体错误。
// `prepareSandbox(case)`：拷贝 fixture 文件到临时目录，返回沙箱路径。
// `cleanupSandbox(workspacePath)`：rmSync 强制清理。
// `loadHeldOutFromUrl(url)`：从 CI 拉 held-out（仓库内只放 .gitkeep，CI 通过 env var 下载）。
//
// 设计原则：fail fast + fail loud —— 任何 schema 不符都直接抛错，不静默通过。
// 这样 dev 改代码时如果误传错 fixture，CLI 第一行就报错而不是 silent fail。

import { readFileSync, existsSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { z } from "zod";
import type { EvalCase } from "./types";

/** zod schema for EvalCase JSON fixture（fail-fast 校验） */
const EvalCaseSchema = z.object({
  id: z.string().min(1),
  taskSetId: z.enum(["held-in", "held-out", "manual"]),
  name: z.string().min(1),
  fixturePath: z.string().min(1),
  permissionProfile: z.enum(["default", "read-only", "no-write", "full-trust"]).default("default"),
  allowedModels: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(
    z.object({
      grader: z.string().min(1),
      expected: z.unknown(),
    }),
  ).min(1),
  budgetUsd: z.number().positive().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  tags: z.array(z.string()).optional(),
  createdAt: z.string().optional(),
});

/** 加载并校验 EvalCase JSON fixture。失败时抛错（fail-fast）。 */
export function loadEvalCase(filePath: string): EvalCase {
  if (!existsSync(filePath)) {
    throw new Error(`fixture 不存在：${filePath}`);
  }
  const raw = readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`fixture JSON 解析失败 ${filePath}：${err instanceof Error ? err.message : String(err)}`);
  }
  const result = EvalCaseSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `fixture schema 校验失败 ${filePath}：${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  // 兜底 createdAt（eval-cases 表需要 NOT NULL）
  return { ...result.data, createdAt: result.data.createdAt ?? new Date().toISOString() } as EvalCase;
}

/** 准备沙箱：把 fixture 文件拷到 mkdtempSync 的临时目录。返回 sandbox 路径。 */
export function prepareSandbox(caseData: EvalCase): string {
  const sandbox = mkdtempSync(join(tmpdir(), `eval-${caseData.id}-`));
  if (existsSync(caseData.fixturePath)) {
    const target = join(sandbox, basename(caseData.fixturePath));
    cpSync(caseData.fixturePath, target, { recursive: true });
  }
  return sandbox;
}

/** 清理沙箱（强制 rmSync，不抛错）。 */
export function cleanupSandbox(workspacePath: string): void {
  try {
    if (existsSync(workspacePath)) {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  } catch {
    // 静默吞——eval runner 整体 try/finally 兜底
  }
}

/**
 * held-out fixture 加载入口：CI 通过 HELD_OUT_FIXTURES_URL 环境变量拉远端 JSON。
 * dev 环境下若没设 env var → 抛错（强制 CI 显式配置）。
 */
export function loadHeldOutFromUrl(_url: string): EvalCase {
  // 不依赖 fetch（保持纯 node 兼容 + 避免在单测里加 fetch mock）—— 让调用方传入已 fetch 好的 JSON
  throw new Error("loadHeldOutFromUrl 需在 CLI 入口实现 fetch；单测走 inline loadEvalCase");
}

/** 扫描 fixture 目录返回所有 .json 文件名（不含 .gitkeep / manifest.json） */
export function listFixtureFiles(dir: string): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f: string) => f.endsWith(".json") && f !== "manifest.json")
    .sort();
}