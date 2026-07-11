# lib/llm/evidence —— 阶段3 证据链模块

> 计划文件：`Cosmgrid-Agent-Harness工程实施计划-2026-07-09.md` 阶段 3

## 职责

把模型回答里的"声明"（修改了哪些文件 / 跑了哪些命令 / 测试通过多少项 / 是否满足验收标准）链接到真实的 `ToolExecutionRow` / `ToolArtifactRef`，输出统一 `VerificationResult` 让 UI 直接展示"证据 + 冲突 + 验收决定"。

## 模块边界

```
lib/llm/evidence/
├── types.ts                # EvidenceRef / ClaimKind / LinkedClaim / ClaimVerdict / VerificationResult / StructuredAcceptanceCriterion
├── claim-extractor.ts      # 5 类声明提取（file_modified / url_fetched / command_executed / test_result / acceptance_met）
├── claim-linker.ts         # 声明 → 证据匹配 + 冲突检测（path/url/loose 匹配 + bash exit-code + 数字对账）
├── evidence-builder.ts     # ToolExecutionRow[] + ToolArtifactRef[] → EvidenceRef[]（复用 selectRowsForMessage 归属）
├── task-verifier.ts        # 核心对账器：消费 EvidenceRef[] 输出 VerificationResult
└── structured-criteria.ts  # verification_closure skill 的 4 种 check 按 kind 调度
```

**dep边界（用 `l8-evidence-no-workflow-tools-runtime` 规则保证）**：
- ✅ 允许 `import type` 引 `tools/result-contract`（用 `ToolArtifactRef` 类型）
- ✅ 运行时引 `harness/fabrication-evidence`（用 `selectRowsForMessage` 归属）
- ❌ 禁止运行时引 `workflow/`（避免循环 + 防止 evidence 反向污染 node-verifier）
- ❌ 禁止运行时引 `tools/`（除 `result-contract.ts`）

## 调用链

```
finalContent + execRows + acceptanceCriteria
   ↓
buildEvidenceRefs(归属 + 装配)
   ↓
EvidenceRef[]    ← 阶段2 ToolResultV2.artifacts 也能装配
   ↓
extractAllClaims(text)
   ↓
LinkedClaim[]   ← verdict 初始全为 insufficient
   ↓
linkClaimsToEvidence(声明 ↔ 证据匹配)
   ↓
LinkedClaim[]   ← verdict 升级为 supported / contradicts / unknown
   ↓
runAcceptanceCriteria(structured-criteria 按 kind 调度)
   ↓
{ metCriteria, failedCriteria }
   ↓
综合判定 → VerificationResult { status: passes|fails|inconclusive }
```

## 关键不变量（来自阶段3 §核心不变量）

1. **Task Verifier 只消费结构化事实**——所有 verdict 由声明 ↔ 证据的匹配结果决定，不由 LLM 自由文本判定
2. **完成必须有证据，不由模型自我宣布**——`status='passes'` 要求所有 linkedClaim 都是 supported
3. **错误降级**——任何抛错都返回 `status='inconclusive'` + humanSummary 提示"证据加载失败"，绝不因证据系统故障让用户回答"失败"

## 测试覆盖

- `__tests__/task-verifier.test.ts` 11 个 case 覆盖计划文件 7 个工作项场景：
  1. 声称修改文件但无 write/edit 记录 → insufficient
  2. bash 返回 error + 声称构建通过 → fails（验收标准触发）
  3. 测试输出与回答数字冲突 → contradicts
  4. 多角色工具记录不会串消息
  5. legacy messageId=null 走 sinceIso 兜底
  6. 证据被截断不冒充通过
  7. 验证失败可解释"缺哪条证据"（humanSummary 含 evidence_id）

## UI 入口

工作面板 dev 模式展开 4 区块（声明 / 证据 / 冲突 / 验收决定）。普通用户只看到 `humanSummary` 一行（自动折叠）。`components/work-panel/EvidencePanel.tsx`。

## 未来扩展点

- `workflow_evidence` 表已 schema 预留（迁移 `202607120001-evidence-store`），给未来的"证据回放 UI"和阶段4 Eval Harness dashboard 用
- `StructuredAcceptanceCriterion.check` 函数可下沉到 `structured-criteria.ts` 之外（自定义判定）—— 当前 kind 调度是阶段3 第一版的简化实现
- 阶段3 暂未注入 `StructuredAcceptanceCriterion.check` 到 skill registry（`verification_closure` 在 registry.ts 里只有 id/description/kind），所以 stream-finalization.ts 现在传 `acceptanceCriteria: []` 给 verifyTask——只跑声明 ↔ 证据对账，不跑结构化验收。阶段4 Eval Harness 把 structured criteria 接进 skill registry 后，这个空数组可以填上真正的标准。