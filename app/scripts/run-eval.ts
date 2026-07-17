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
import { getLanguageModel } from "../src/lib/llm/provider-factory";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// LLM judge 模型（eval:full 软标准用）：三个环境变量齐全才构造，缺任一 = 纯 deterministic。
//   EVAL_JUDGE_PROVIDER  anthropic / openai / google / openai-compatible
//   EVAL_JUDGE_MODEL     judge 模型名
//   EVAL_JUDGE_API_KEY   对应 key（CLI 环境拿不到 app keychain，只能显式传）
//   EVAL_JUDGE_BASE_URL  可选，openai-compatible 必填
function resolveJudgeModel(): unknown | undefined {
  const provider = process.env.EVAL_JUDGE_PROVIDER;
  const model = process.env.EVAL_JUDGE_MODEL;
  const apiKey = process.env.EVAL_JUDGE_API_KEY;
  if (!provider || !model || !apiKey) return undefined;
  return getLanguageModel(provider, model, apiKey, process.env.EVAL_JUDGE_BASE_URL);
}

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

  const judgeModel = resolveJudgeModel();
  if (!judgeModel && args.taskSet === "held-out") {
    console.warn(
      "[eval] EVAL_JUDGE_PROVIDER/MODEL/API_KEY 未配齐，llm-judge B 档将 inconclusive（A 档短路不受影响）",
    );
  }

  const { runId, results } = await runEvalSuite({
    taskSetId: args.taskSet,
    fixtureDir,
    fixtureFiles: files,
    config: {
      taskSetId: args.taskSet,
      modelId: args.modelId,
      harnessVersion: args.harnessVersion,
      judgeModel,
    },
    // CLI 跑在纯 Node：DB 走 tauri-plugin-sql 需要 WebView window，落库必挂。
    // 指标聚合只用内存 results，不依赖 DB；落库版历史对比走 app 内 EvalPanel。
    persist: false,
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