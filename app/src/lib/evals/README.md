# lib/evals —— 阶段 4 任务级 Eval Harness

> 计划文件：`Cosmgrid-Agent-Harness工程实施计划-2026-07-09.md` 阶段 4

## 职责

把 Harness 的"完成度"量化：11 个指标（completion_rate / pass_at_1 / pass_at_3 / verifier_pass_rate / harness_violation_rate / retries_per_task / human_interventions / recovery_rate / cost_per_success / latency_per_success / context_continuity_rate）让每次改动都有量化对比。

## 模块边界

```
lib/evals/
├── types.ts                  # EvalCase / EvalRun / EvalResult / EvalMetrics / TaskOutcome
├── runner.ts                 # 核心编排：deterministic + llm-judge + 预算超限 + pass_at_3
├── metrics.ts                # 11 个指标的纯函数聚合
├── compare.ts                # 两次 run diff（regression / improvement / overall）
├── llm-judge.ts              # LLM-as-judge 软标准（A/B 档分流）
├── fixture-loader.ts         # zod 校验 + 沙箱拷贝 + cleanup
├── task-outcome-reporter.ts  # stream-finalization 上报 task_outcomes
├── graders/
│   ├── types.ts              # 5 个 deterministic grader + 注册表
│   └── index.ts              # 桶导出
├── fixtures/
│   ├── held-in/*.json        # 20 个 held-in 用例（CI 跑）
│   ├── held-out/.gitkeep     # held-out 占位（仓库内不存，CI 通过 secret URL 拉）
│   └── manual/manifest.json  # S1-S9 真机剧本映射
└── __tests__/                # 8 个测试文件
```

**dep边界（用 `l9-evals-no-ui-runtime` 规则保证）**：
- ❌ 禁止 `import` pages/components 运行时（只允许 `import type`）
- ✅ 允许 `import` `db/usage-events` / `db/tool-executions` / `db/workflow-runs`（数据源）
- ✅ 允许 `import` `evidence/task-verifier`（复用阶段 3 的 VerificationResult）
- ✅ 允许 `import` `harness/fabrication-judge` 的 `judgeFabrication`（LLM-as-judge 软标准）

## 5 个 deterministic grader

| grader 名 | 检查内容 | 失败模式 |
|---|---|---|
| `filesystem` | workspacePath 下的文件存在 + 内容正则匹配 | 文件不存在 / 不含模式 / 长度不足 |
| `command-exit-code` | tool_executions 找 bash 记录 status=success | 找不到 / 失败 |
| `workflow-artifact` | workflow_runs 的 artifact_json 含 planSourceKind | kind 不匹配 |
| `tool-execution` | tool_executions 按 toolName + minCount 查 | 调用次数不足 / input 不匹配 |
| `evidence-complete` | 调 verifyTask 检查 status | status 不匹配 |

## 调用链

```
EvalCase (fixture JSON)
  ↓ loadEvalCase / zod 校验
  ↓ prepareSandbox (mkdtempSync)
  ↓
runEvalCase (max 3 attempts)
  ↓ for each AcceptanceCriterion:
  ↓   getGrader(ac.grader)(ac.expected, ctx)
  ↓   accumulate GraderResult
  ↓
EvalResult (passed: bool|null)
  ↓
aggregateEvalMetrics (all attempts)
  ↓
EvalMetrics (11 指标)
```

## 关键不变量

1. **deterministic grader 只消费结构化事实**——不调用网络，不调 LLM
2. **LLM judge 抛错 → passed=null**（inconclusive，不冒充通过）
3. **预算超限 → 立即 BUDGET_EXCEEDED 终止**（不继续消耗）
4. **沙箱 cleanup 走 try/finally**——保证不留临时目录
5. **held-out 不入仓**——CI 通过 `HELD_OUT_FIXTURES_URL` secret 下载，避免 dev 偷看 expected
6. **cost_per_success 涨 >30% 红色告警**——不阻断，但 reviewer 决定真假问题

## 测试覆盖

- `__tests__/graders.test.ts` 11 case（5 grader × 2 + 1 tool-execution input 匹配）
- `__tests__/metrics.test.ts` 9 case（11 指标全覆盖 + 0 attempts 边界）
- `__tests__/fixture-loader.test.ts`（valid / missing / invalid-zod / cleanup / held-out）
- `__tests__/runner.test.ts` runner × llm-judge 集成（2026-07-17 接线：A 档否决 / 向后兼容 / B 档认可 / inconclusive 不翻案）
- 未来补 `__tests__/{llm-judge,task-outcome-reporter,compare}.test.ts`

## CI 接入

```bash
pnpm test:eval       # vitest 单测（CI 必跑）
pnpm eval:fast       # 20 held-in deterministic（CI PR check，秒级）
pnpm eval:full       # held-in + held-out + llm-judge（workflow_dispatch / nightly）
                     # llm-judge B 档需配 EVAL_JUDGE_PROVIDER / EVAL_JUDGE_MODEL / EVAL_JUDGE_API_KEY
                     # （可选 EVAL_JUDGE_BASE_URL）；未配齐 = B 档 inconclusive，A 档短路照常
pnpm eval:real-machine # 真机 Tauri 安装包（独立环境）
```

## UI 入口

`components/work-panel/EvalPanel.tsx` 挂在 `ChatWorkPanel.tsx` 第 189-195 行 `{developerDiagnosticsEnabled && ...}` 块内：

```tsx
<EvalPanel runs={evalRuns} results={evalResults} devMode={true} />
```

普通用户只看到折叠标题 + "暂无评估" 占位；dev 模式展开 4 区块（最新 run 总览 / 11 指标 / cost spike 告警 / 失败类型直方图）。

## 未来扩展点

- **20 个 held-in 用例补全**：阶段 4 第一版只放了 2 个代表性 JSON（01-read-project / 02-generate-plan），其余 18 个留给阶段 9 真机剧本时补
- **真机 S1-S9 单独跑**：`pnpm eval:real-machine` 走 Tauri 安装包，不在 dev 流程
- **EvalPanel 接入 held-in diff**（阶段 5 Playbook）：每次 PR 自动跑 eval:fast + compare 两次 run 的 regression 列表
- **held-out fixture 远程下载**：通过 `HELD_OUT_FIXTURES_URL` secret 拉，仓库内只放 .gitkeep
- **模型特定 grader**（阶段 6 Profile）：MiniMax-M3 / GPT-4 / Claude 各有特定 hallucination 模式 grader