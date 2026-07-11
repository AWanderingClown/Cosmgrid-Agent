// Harness 工程实施计划 阶段4 — CLI Eval Runner 入口。
//
// 用法：
//   pnpm eval:fast         # CI 默认：纯 deterministic + held-in
//   pnpm eval:full         # workflow_dispatch + nightly：含 held-out + llm-judge
//   pnpm eval:real-machine # 真机 Tauri 包里跑
//
// 阶段4 第一版：CLI 是 eval runner + 调 runEvalSuite 的薄壳。详细指标 / 报告
// 输出在阶段 5（Playbook）后做更深入的 diff + 直方图。

import { runEvalSuite } from "../src/lib/evals/runner";
import { listFixtureFiles } from "../src/lib/evals/fixture-loader";
import { aggregateEvalMetrics } from "../src/lib/evals/metrics";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

interface CliArgs {
  taskSet: "held-in" | "held-out" | "manual";
  modelId: string;
  harnessVersion: string;
  json: boolean;
  realMachine: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const taskSet = argv.includes("--held-out") ? "held-out" : "held-in";
  const realMachine = argv.includes("--real-machine");
  const modelArg = argv.find((a) => a.startsWith("--model="));
  const modelId = modelArg ? modelArg.split("=")[1]! : "default";
  const harnessVersion = (() => {
    try {
      return execSync("git rev-parse --short HEAD").toString().trim() || "v0";
    } catch {
      return "v0";
    }
  })();
  return {
    taskSet: realMachine ? "manual" : taskSet,
    modelId,
    harnessVersion,
    json: argv.includes("--json"),
    realMachine,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixtureDir = join(process.cwd(), "src/lib/evals/fixtures", args.taskSet);
  const files = listFixtureFiles(fixtureDir);
  if (files.length === 0) {
    console.error(`[eval] no fixtures in ${fixtureDir}`);
    process.exit(1);
  }

  const { runId, results } = await runEvalSuite({
    taskSetId: args.taskSet,
    fixtureDir,
    fixtureFiles: files,
    config: {
      taskSetId: args.taskSet,
      modelId: args.modelId,
      harnessVersion: args.harnessVersion,
    },
  });

  // 聚合 11 指标
  const allAttempts = results.flatMap((r) => r.attempts);
  const metrics = aggregateEvalMetrics(allAttempts);

  const output = { runId, harnessVersion: args.harnessVersion, taskSet: args.taskSet, totalCases: results.length, metrics };
  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`[eval] runId=${runId} taskSet=${args.taskSet} cases=${results.length}`);
    console.log(`  completion:    ${(metrics.completionRate * 100).toFixed(0)}%`);
    console.log(`  pass@1:        ${(metrics.passAt1 * 100).toFixed(0)}%`);
    console.log(`  pass@3:        ${(metrics.passAt3 * 100).toFixed(0)}%`);
    console.log(`  verifier:      ${(metrics.verifierPassRate * 100).toFixed(0)}%`);
    console.log(`  violation:     ${(metrics.harnessViolationRate * 100).toFixed(0)}%`);
    console.log(`  cost/success:  $${metrics.costPerSuccess.toFixed(3)}`);
    console.log(`  retries/task:  ${metrics.retriesPerTask.toFixed(1)}`);
  }
}

main().catch((err) => {
  console.error("[eval] failed:", err);
  process.exit(1);
});