# lib/llm/playbook —— 阶段 5 上下文 Playbook

> 计划文件：`Cosmgrid-Agent-Harness工程实施计划-2026-07-09.md` 阶段 5

## 职责

把项目上下文升级为**可增量维护、可追溯、可纠错的用户资产**：
- Playbook 是事实库（增删改 + 来源 + 反馈），不复述对话
- 三段式 Generator → Reflector → Curator
- harmful_count 高的条目降权不静默删
- 检查点的 failedAttempts / doNotRepeat 自动转成候选

## 模块边界

```
lib/llm/playbook/
├── types.ts                  # PlaybookItem / PlaybookEvent / PlaybookCandidate / CuratorDecision / CuratorAction / PlaybookStatus
├── reflector.ts              # 纯函数 reflectPlaybookEvents(events) → PlaybookCandidate[]
├── curator.ts                # 纯函数 curateCandidates(candidates, existing) → CuratorDecision[]
├── context-assembler.ts      # 检索 + 加权 + 截断（assemblePlaybookContext）
├── feedback.ts               # recordMemoryHelpful / Harmful / Used 三件套（旁路 try/catch）
└── README.md
```

**dep边界（用 `l10-playbook-no-ui-runtime` 规则保证）**：
- ❌ 禁止 `import` pages/components 运行时（只允许 `import type`）
- ✅ 允许 `import` `db/memory`（数据底座）+ `db/playbook-events`（事件流）
- ✅ 允许 `import` `harness/conversation-harness` / `evidence/task-verifier`（阶段3 复用）
- ✅ 允许 `import` `harness/fabrication-judge`（LLM 软标准留扩展点）

## 三段式流程

```
正常任务执行
  ↓ 5 类事件入口
memory_playbook_events（事件流表）
  ↓ 周期消费
reflectPlaybookEvents（纯函数）
  ↓ 5 类 → 4 种 candidate kind
PlaybookCandidate[]
  ↓ 7 种 CuratorAction
curateCandidates（纯函数）
  ↓ requiresConfirm 决策
CuratorDecision[] → requireApprovalAsV2
  ↓ 落库
project_memories（事实库 + 9 字段 + 3 索引）
  ↓ 检索加权 + 截断
assemblePlaybookContext → prompt 装配
```

## 5 类事件 → 4 种 candidate kind

| PlaybackEventKind | 提炼规则 | confidence |
|---|---|---|
| `checkpoint_failed` | failedAttempts → lesson + doNotRepeat → lesson | 0.9 |
| `summary_dropped` | keyDecisions → context + openThreads → lesson | 0.7 / 0.5 |
| `outcome_failed` | failure_code → lesson | 0.8 |
| `outcome_needs_user` | intervention_kind → preference | 0.6 |
| `tool_success` / `outcome_passed` | skip（避免噪音） | — |

## 7 种 CuratorAction

| Action | 触发条件 | requiresConfirm |
|---|---|---|
| `skip` | 标题完全相同 | false |
| `supersede` | 标题相似度 ≥ 0.8 + 同一 kind | false |
| `mark_disputed` | 内容矛盾（detectConflict） | true |
| `create` | 高 confidence (≥0.95) + kind='context' | false（自动入） |
| `create` | 中 confidence 或 kind !== 'context' | true |
| `update_helpful` / `update_harmful` | 用户反馈 | true |
| `mark_archived` | harmful_count > 3 | true |

## 加权模型（context-assembler）

| 维度 | 加权 |
|---|---|
| importance 0-100 | /100 |
| confidence 0-1 | +confidence |
| tags 命中 input.taskKeywords | +0.2 / 命中 |
| workspace 路径匹配 | +0.1 |
| harmful_count > 3 | -0.3 |
| helpful_count > 0 | +0.05 |
| last_used_at 30 天内 | +0.02 |

截断：top 30 条 + 总字符 ≤ 4000（与 fabrication-evidence 的 FABRICATION_TOTAL_MAX 保持一致）。

## 关键不变量

1. **纯函数**：Reflector / Curator / scoreItem 都是纯函数，相同输入永远产生相同输出（snapshot 测试友好）
2. **旁路 try/catch**：所有 Playbook 写入失败静默 console.error，不阻塞主对话流
3. **错误降级**：摘要压缩失败 → notice，不影响 Playbook 写入（沿用 `compressHistoryWithSummary` 的 notice 模式）
4. **不静默删除**：harmful_count > 3 → mark_archived，保留 row + supersede 链可追溯
5. **不破坏核心流**：`chat-fallback.ts` 不动，只在 StreamCallbacks 加 3 个 optional 钩子（默认 no-op）
6. **高 confidence 自动入**：仅 `kind='context'` + `confidence ≥ 0.95`；决策/偏好/lesson 永远 confirm
7. **数据回填**：迁移里 `UPDATE` 现有 `project_memories` 行 `status='active', source_kind='legacy'`

## StreamCallbacks 3 个新钩子

```typescript
onMemoryUsed?: (memoryIds: string[]) => void;     // context-assembler 注入的 memory id 列表
onMemoryHelpful?: (memoryId: string) => void;     // 用户点 👍
onMemoryHarmful?: (memoryId: string) => void;     // 用户点 👎（多次触发 archived）
```

调用方（ChatPage / ChatWorkPanel）在 context-assembler 后调 `onMemoryUsed`，UI 提供"赞 / 踩"按钮触发后两个。

## 测试覆盖（25 个新增 case）

| 模块 | case 数 | 关键断言 |
|---|---|---|
| `reflector.test.ts` | 5 | checkpoint_failed → lesson / outcome_failed → lesson / summary_dropped → context / outcome_needs_user → preference / tool_success → skip |
| `curator.test.ts` | 6 | skip（重复）/ supersede（相似）/ mark_disputed（矛盾）/ create 自动入（高 confidence）/ create requiresConfirm（kind !== context）/ skip Levenshtein 边界 |
| `context-assembler.test.ts` | 4 | status=active 过滤 / 排序（helpful 加权 / harmful 降权）/ 截断 ≤ 4000 字符 / tags 命中加权 |
| `feedback.test.ts` | 3 | recordMemoryHelpful / Harmful / Used 三件套调用正确（旁路 try/catch） |
| `playbook-events.test.ts` | 7 | 5 种 eventKind 写 / listByProject / listByConversation / listByProjectSince（Reflector 周期消费） |

## 未来扩展点

- **LLM 软标准**（阶段 8 后）：当前 `detectConflict` 是 heuristic，LLM 软标准可以更准确判断内容矛盾
- **embedding 重训**（阶段 6 后）：Playbook 加入向量索引，配合 helpful/harmful 做个性化检索
- **跨项目 Playbook**（阶段 6+）：当前只取 projectId 内的，跨项目复用留 `excludeProjectId` 模式
- **Stage 9 真机覆盖**：S1-S9 真实事件流 → 验证 reflector 提炼准确率 ≥ 80%