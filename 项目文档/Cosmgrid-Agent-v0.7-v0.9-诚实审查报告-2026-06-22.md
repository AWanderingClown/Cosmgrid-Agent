# Cosmgrid-Agent 诚实审查报告

**日期**：2026-06-22
**审查范围**：v0.7 阶段 4（工具执行层 4a/4b）+ v0.8 阶段 5（多模型对弈）+ v0.9 阶段 7（智能省 token：SmartRouter + 语义缓存 + StatsPage）
**审查者**：MiniMax-M3（按用户"毫不留情的诚实审查"要求）
**审查方法**：跑 tsc / vitest / tauri dev 实测 + 逐文件读关键代码 + 交叉对照规划方案

---

## 0. 我实际跑过的东西（证据）

| 验证项 | 结果 |
|---|---|
| `pnpm tsc --noEmit` | ✅ 0 错误（tsc 静默退出） |
| `pnpm vitest run --reporter=verbose` | ✅ **368 个测试 / 30 个文件 / 7.66s 全部通过**（用户说的"368 个测试"是真的） |
| `pnpm tauri dev` | ✅ **实际启动成功**：Rust 编译 24.76s，`target/debug/cosmgrid-agent` 进程 PID 28830 存活 4.60s CPU，Vite HTTP 200，零错误日志 |

**没做的事**：没在 App 里手动点过 UI（GUI 操作需要鼠标；但 Tauri 进程活了 + Vite 200 + Rust 命令注册了 = 真实启动链路是通的）。如果需要 E2E 验证得用 Playwright 自动化。

---

## ① ✅ 真能用（端到端接通）

按"用户在 App 里点一下真能跑通"的标准：

| 功能 | 验证证据 | 备注 |
|---|---|---|
| **多模型对话** | ChatPage → streamWithFallback → provider-factory → Vercel AI SDK → Tauri 无依赖 | 真 API 调用已通过 cli-engine（spawn CLI）或 provider-factory（API 直连）接通 |
| **回退链切换** | streamWithFallback 行 154-264：cooldown 跳过 + shouldFallback 切下一个 + onSwitched 通知 UI | 单测覆盖 + 真路径接通 |
| **CLI 引擎（spawn claude/codex 吃订阅）** | cli-engine.ts → invoke("spawn_cli_stream") + Channel 流式回传；lib.rs 行 39-82 实注册；POLLUTING_ENV_PREFIXES 抹掉污染变量 | MEMORY 已确认 2026-06-21 实测跑通 |
| **claude-mem 移除 / 原生 memory** | MEMORY 显示已禁用改用原生 | |
| **read/glob/grep 工具** | Tauri plugin-fs + walkFiles（glob 自实现 + 默认忽略 node_modules 等） + capabilities $HOME/** 授权 | 在真实 App 里调这些工具，读自己项目文件 → 应能用 |
| **edit/write 工具** | path-safety（边界 + 敏感路径） → 用户确认弹窗 → fs.writeTextFile + git snapshot | 写操作会真触发确认 UI |
| **bash 工具** | command-safety 三道闸（危险模式 / 白名单 / 项目黑名单）→ 用户确认 → invoke("run_shell_command") → Rust `sh -c` | ⚠️ 注意：用的是 `sh -c`（不是规划方案说的 sidecar） |
| **写操作 git 回滚** | edit/write 成功后 snapshotWrite → invoke("git_commit_file") → Rust `git add -- <path>` + `git commit -m <msg> -- <path>`（路径与消息作为独立参数，**不经 sh -c**，杜绝 shell 注入） | 安全设计 |
| **工具确认 UI（写操作暂停）** | ProjectDetailPage requestConfirm 行 187-192 用 Promise + resolverRef 模式，AI 调工具 → 弹窗 → 用户点按钮 → resolve(stream 继续) | **正确实现**，单步或多步循环都会真暂停 |
| **多模型对弈** | DebatePage.tsx:83 真用 `runDebate(input, realRunRole)`；realRunRole 行 14-55 真调 generateText/streamViaCli + recordUsageEvent(role=debate_<角色>) | 真调模型（不是 mock），历史落 debate_sessions 表 |
| **对弈历史回看** | debateSessions.create/list/getById/delete 都接通 | |
| **StatsPage 数据源** | StatsPage 4 个数据源真连 DB：usageEvents（30天） + semanticCache.stats + modelPerformanceStats.list + toolExecutions.list(30) | 数据真 |
| **UsageEvent.role 字段** | db.ts 行 258 `role TEXT` + chat-fallback 行 237 `params.role = options.role ?? inferRole(messages)`（按最后 user 消息推 complexity） | SmartRouter 评分的数据源打通 |
| **UsageEvent 增量喂 ModelPerformanceStat** | usage-tracker.ts:54 写完 UsageEvent 后调 recordPerformanceSample → modelPerformanceStats.upsert | 滚动统计打通 |
| **语义缓存（保守版）** | ChatPage 行 196 真调 lookupCache；hit 后 setCacheNotice + 直接返回 0 成本；命中后 recordHit 累加 | 真实流程通 |
| **写缓存过滤** | similarity.ts isCacheable：时间敏感 query + 含代码答案 → 不入缓存 | 安全设计 |
| **SemanticCache 数据落库** | semanticCache.create / listValid / recordHit / deleteExpired / stats 五个 API 全通 DB | |
| **首次启动 OnboardingModal + 新建项目向导** | 4 步引导 + 2 步向导 | UI 完成 |
| **长期记忆 RAG** | project_memories 表 + 跨项目关键词检索 | v0.6 已完成 |

---

## ② ❌ 半成品 / 假的（按严重度排序）

| # | 严重度 | 项目 | 实际情况 | 原因 |
|---|---|---|---|---|
| 1 | 🔴 高 | **v2 SmartRouter 评分路由** | 写了完整算法 + 决策日志，但**当前 100% 走 v1 fallback** | `isScoreEligible` 要求 sampleCount ≥ 30；用户从 v0.6 至今没积累 30 条同 taskType 的 UsageEvent（也还没接路由层用到 score 的入口） → **评分路径现在就是死代码** |
| 2 | 🔴 高 | **bash 工具的 sidecar 模式** | lib.rs 行 103 是 `command("sh").args(["-c", &command])` —— **没用 sidecar** | 规划方案 v2 最优里"禁止 sh -c 动态 shell"的红线没落地。已知危害：用户输入里若有 `;` 或 `&` 串联，TS 侧白名单只能逐段审（已实现），但 `$()` 和反引号**已被黑名单拦截**——这点 OK，但仍是 sh -c，不是 sidecar |
| 3 | 🔴 高 | **MCP 集成（v0.7 阶段4 提到）** | **完全没做** | 阶段 4 任务表里 4b.5 / 4b.6 / 4b.6-SSE 全是规划，没有 `mcp__xxx` 工具实现 |
| 4 | 🟡 中 | **embedding = 关键词哈希占位** | embedding.ts:69 `keywordEmbeddingProvider`，不是真神经 embedding | 用户已知。CLAUDE.md/MEMORY 都明说"先用关键词哈希，v0.9.1 再 spike transformers.js"。问题是：中文 query 命中率极低（CJK token 化只到二元组），同义改写基本击不中 → **语义缓存目前等同于精确文本匹配缓存**，省不了多少 token |
| 5 | 🟡 中 | **CLI 引擎 abort 杀子进程** | cli-engine.ts 行 112-118 有 TODO：**abort 后子进程没真 kill**，白耗订阅额度 | 已知技术债，写在注释里 |
| 6 | 🟡 中 | **MCP SSE / streamableHttp transport** | 推到 v0.8+ | 规划里写明了，没做 |
| 7 | 🟡 中 | **git worktree 隔离** | **没做**（snapshotWrite 走单文件 commit，不是 worktree） | 阶段 4b.4 没做。后果：AI 改文件不会开 worktree，主分支直接被污染 |
| 8 | 🟡 中 | **WorkspaceConfig UI** | 表已建（workspace_configs） + blockedCommands API 已通；UI 在 ProjectDetailPage 行 700-713 有"工具安全"标题 + blockedPlaceholder + 保存按钮。**但没看到 requireConfirmation / worktreeEnabled 字段的 UI 暴露** | 表 schema 没读完整，可能部分字段缺 |
| 9 | 🟡 中 | **StatsPage 实际显示效果** | 代码全通，但**今天 = 0 / last7d = 0 / cacheHits = 0 / perf=空 / toolExecs=空**（因为还没有任何 UsageEvent 真实落盘） | "数据真连"≠"数据有"——只有用户真实用过才有内容 |
| 10 | 🟢 低 | **git_status / git_diff / git_log 工具** | 规划里说要做，**实现目录里没找到** `git-tool.ts` 或类似文件 | 阶段 4a.5 任务挂账 |
| 11 | 🟢 低 | **web_search / web_fetch 工具** | 同上，**没找到** | 阶段 4a.6 任务挂账 |
| 12 | 🟢 低 | **PromptCompressor（Anthropic cache_control 5min TTL）** | context-compressor.ts 实现了基础版（按 chars/3 估算 + 裁掉较早消息 + 插省略提示），**但没真接 cache_control** | 规划说要做，未落地 |
| 13 | 🟢 低 | **DebatePage 复杂问题检测（ChatPage 建议升级对弈）** | 阶段 5.12 任务里说要 ChatPage"含对比/分析等词 → 建议对弈" | ChatPage 里没看到这个检测逻辑，message-router.ts 里有 classifyMessageComplexity 但没联动 DebatePage |
| 14 | 🟢 低 | **debate 5b 评测框架（LLM-as-judge + 用户满意度）** | 完全没做 | 阶段 5b 整体挂账 |
| 15 | 🟢 低 | **debateRole / debateSessionId 在 UsageEvent 表里** | 规划方案说"扩 UsageEvent.role 字段"，但**真实字段名是 `role`（存 complexity）**，debate 角色用 `debate_<role>` 前缀（debate-runner.ts 行 49）→ 字段复用 OK，没改 schema | 不是 bug，但统计时需要 split prefix |

### ⚠️ 测试真实性问题（重要）

**所有 vitest 测试都用 mock 适配器**（`setShellAdapter(mock)` / `vi.mock("../../db")`），没有任何一个测试**真调 Tauri Rust 命令**或**真读写真实文件**。所以：

- ✅ 单测证明了**逻辑分支**（白名单拦截、确认拒绝、增量均值数学、相似度阈值）都对
- ❌ 单测**不能证明**"在真 Tauri App 里 invoke('run_shell_command') 能跑通"
- ✅ 但 Tauri dev 真编译并启动了 cosmgrid-agent 进程 = Rust 命令注册了，invoke backend 是活的

**测试覆盖率**：vitest 配置了 80% 阈值；实际覆盖率没单独跑 v8 report（需要的话跑 `pnpm vitest run --coverage` 确认是否真达标）。

---

## ③ 🛠️ 最该优先优化/补的 5 件事

按 **"价值密度 × 真实可用差距"** 排序：

### 1️⃣ 把 read/edit/write/bash 在真实项目里跑一次端到端冒烟测试
**为什么排第一**：所有工具代码都通、测试都过、Tauri App 也启了，但**没有任何一次"AI 真的改了我项目里一个文件并触发确认弹窗"**的端到端验证。这是用户的**产品真北 #2（要"真能陪用户把活干完"）**的核心。
**怎么做**：用 Playwright（已在 dependencies 里，e2e-runner 可用）+ 真实 API key（比如作者已有 Claude 订阅），做一次：ChatPage 提问"读 package.json" → 看到 read 工具被调 → 改文件 → 弹确认框 → 点批准 → 文件真改了 → git commit 落库 → ToolExecution 落库。

### 2️⃣ 用 v0.4.1 风格的 fallback 链做一次"限额无缝续"
**为什么排第二**：这是用户痛点 #1，CLAUDE.md 真北明确写了"模型被切了上下文不丢"。streamWithFallback 已经支持 N 步 fallback，但**没有 e2e 测**主模型配额耗尽 → 自动切 fallback → 上下文完整传递的全过程。
**怎么做**：写一个 Playwright 脚本：配置主模型 = 一个故意配额满的 provider，备用 = 有 key 的。问一个问题，验证 UI 顶部出现"已自动切到 XXX"提示，且对话历史完整传给新模型。

### 3️⃣ 真跑一次 debate 看 3 个模型输出
**为什么排第三**：用户痛点 #2。DebatePage 真实用 `runDebate + realRunRole`，但**目前作者没真实跑过 3 模型对弈**。需要真实 API key + 真实问题，验证：3 轮串行调通（solver → critic → judge） + UsageEvent 落库（role=debate_*）+ UI 3 面板可折叠 + 最终方案合理。
**风险点**：Opus 4.8 用 adaptive thinking（不能手动 extended thinking），debate-engine prompt 没针对 adaptive thinking 优化，可能输出不如预期。

### 4️⃣ 接 ToolLoopAgent / Experimental_Agent 把"多步工具循环"真打通
**为什么排第四**：现在 streamWithFallback 传 tools 后，AI 调 read → 返回结果 → AI 调 edit → 再返回结果……这个**多步循环是 Vercel AI SDK 自动处理的**（`stepCountIs(8)`），但**没有端到端验证过**"AI 自主规划 '先读文件 → 再编辑 → 再 git diff 看效果' 这种 agentic 流程"。
**怎么做**：单测模拟一遍多步（mock 多 tool 调用）；Playwright 跑一次真实多步循环。验证 ctx.confirm 在多步里能正确暂停/恢复。

### 5️⃣ 把"embedding 占位"替换成本地 all-mpnet-base-v2
**为什么排第五**：v2 方案"实施顺序 Day 2（8h）"就该做的；现在拖到 v0.9 也没做。关键词哈希对中文 query 命中率极低（CJK 只切到二元组），语义缓存基本失效，省不了 token。**spike 2h 跑通 transformers.js 在 Tauri WebView 兼容性**（MEMORY 已记录这是 TODO）。

---

## ④ 4 个痛点逐条打分

> **打分规则**：0=没做 / 1=代码完但 demo 级 / 2=端到端接通但没真实用过 / 3=真实用过且稳定 / 4=超越预期（用户亲口认可）

### 痛点 1：套餐限额无缝续 + 跨 app 丢上下文 → **2.5/4**
- ✅ chat-fallback.ts 实现 streamWithFallback（cooldown 跳过 + shouldFallback 切下一个 + 整段 messages 传给下一模型 = 上下文完整传递）
- ✅ AppSettings 有智能路由开关
- ❌ **没真实跑过"主模型 401/429 → 自动切 fallback → 同一段对话继续"** 的端到端验证
- ❌ CLI 引擎 abort TODO 没修（abort 后子进程还跑 = 额度照扣）
- **打分理由**：架构全对，**demo 级完成 → 真实可用之间的临门一脚**

### 痛点 2：单模型自我认知幻觉 → **1.5/4**
- ✅ runDebate + realRunRole 真调 3 个模型（Solver/Critic/Judge）
- ✅ DebatePage UI 三面板 + 历史回看 + 快速模式
- ❌ **作者没真实跑过 3 模型对弈**——realRunRole 接通但从没在 App 里点过"开始对弈"
- ❌ 阶段 5b 评测框架（LLM-as-judge + 用户满意度）完全没做
- ❌ ChatPage"复杂问题自动建议对弈"没做（message-router 的复杂度分类没联动）
- ❌ ToolLoopAgent/Experimental_Agent 没用，全是 generateText 串行
- **打分理由**：代码全通，**但用户从没真用过 → demo 级**

### 痛点 3：全程强模型用不起 + 切便宜模型断记忆 → **2/4**
- ✅ message-router.ts pickModelForMessage 按 complexity 分档（simple→fast，hard→flagship）
- ✅ SmartRouter v2 算法完整（评分 + 配额降级 + v1 fallback），但 **30 样本门槛意味着评分路径当前是死代码**
- ✅ context-compressor.ts 压缩超长历史（按 chars/3 估算 + 保留 system + 最近 minRecent 条）
- ❌ Anthropic cache_control 5min TTL **没接**（规划里要做，没做）
- ❌ SmartRouter 评分要用户积累 30 条同 taskType 样本 → 新用户 / 新项目 = 100% 走 v1
- **打分理由**：v1 路由器 + 压缩 + 缓存都是真的；**但 v2 真智能路由仍是纸面**——恰好是用户最在意的"真省钱"环节

### 痛点 4：配置与使用割裂 → **3.5/4**
- ✅ ProvidersPage 一处配所有 provider + API key（存系统 keychain）
- ✅ TokenPlansPage 套餐管理 + warningThresholds UI 接通
- ✅ AppSettings 智能路由开关（SettingsPage 默认开启 + 可关）
- ✅ Models 按 workRoles/capabilityScore 自动派（pickBestModelForRole）
- ✅ workspaceConfigs 项目级 blockedCommands（ProjectDetailPage 行 700+ UI 暴露）
- **打分理由**：这是**四个痛点里最接近"真解决"的一个**，用户切模型不用跨 App。**唯一扣分**：手动切还得去 ChatPage 顶部下拉，没做到"自动按复杂度切"（虽然 SmartRouter 设计了，但评分未生效）

---

## 总分：**2.4 / 4**

---

## 加分项 / 意外发现

1. **架构返工（v0.3 Prisma → tauri-plugin-sql）做对了**：现在打包成 .app/.dmg 给用户机器没 Node 也能跑。src-tauri 里只有 3 个 Rust 函数（spawn_cli_stream / run_shell_command / git_commit_file），全是最小必要的"平台能力"，业务逻辑全在 TS。
2. **工具层抽象漂亮**：ToolDefinition<TInput> 通用接口 + zod 参数校验 + executeTool 统一审计 + buildAiSdkTools 转 Vercel AI SDK tool——任何后续加新工具就是写一个 ToolDefinition 注册。
3. **确认 UI 用 async resolver 模式正确**：streamText 触发 confirm() → Promise pending → 弹窗 → 用户点 → resolve → stream 继续。这是 streaming agentic UI 的**正确实现**，不是 setTimeout 轮询假暂停。
4. **CLI 引擎污染隔离设计扎实**：抹掉 ANTHROPIC_/CLAUDECODE 等前缀 + `--setting-sources ""`，避免被 cc switch 注入污染（MEMORY 里有"实测吃订阅五小时额度"为证）。
5. **git-snapshot 不经 sh -c**：路径与消息作为独立参数传给 git，杜绝 shell 注入（lib.rs 行 121-149）。**这是规划里说要做的，**真做了**。

---

## 需要用户决策的 5 件事

1. **是否现在用 Playwright 做端到端冒烟测试**？（强烈推荐：先做"AI 改文件 + 弹确认框 + 写盘 + git commit"一条龙）
2. **embedding 升级**：spike transformers.js 2h？还是接受关键词哈希现状，把精力投到别的？
3. **bash 改 sidecar**：要不要做？v2 方案说要做，但 sh -c + 黑白名单三道闸已经够安全（除非你想把 vibe coder 边界再收紧）
4. **MCP 是否推到 v0.8+**？（规划已推迟，但用户痛点里没有"MCP"——可能是低优先）
5. **debate 5b 评测**：等用户真跑几次 debate 收集反馈？还是先做 LLM-as-judge 自动评分？

---

## 附：技术栈 / 路径速查

- 项目根：`/Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/`
- 前端：`app/src/`（React 19 + TS + Vite 7 + Vitest 4）
- Rust 后端：`app/src-tauri/src/lib.rs`（162 行，3 个 #[tauri::command]）
- Tauri 配置：`app/src-tauri/tauri.conf.json` + `app/src-tauri/capabilities/default.json`
- LLM 抽象层：`app/src/lib/llm/`（21 个文件）
- 工具执行层：`app/src/lib/llm/tools/`（16 个文件）
- 关键表 schema：`app/src/lib/db.ts`（14 张表）
- 测试 30 个文件 / 368 个用例，单测通过率 100%，但 100% mock 适配器，无真 Tauri 集成测试
- 规划文档：`/Users/shaoyitong/Desktop/Cosmgrid-Agent-v0.7-v0.9-规划/规划方案-v2最优.md`
- 项目记忆：`~/.claude/projects/-Users-shaoyitong-Desktop----Cosmgrid-Agent/memory/MEMORY.md`

---

报告完。