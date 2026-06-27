# Cosmgrid-Agent — Claude Code 项目指令

## 项目定位
多模型 AI 编程桌面工具。跟 Claude.app Code / Codex App / OpenCode App 同一品类，差异化是"多 AI 协作 + 任务流可视化 + 对 vibe coder 友好"。

> ⚠️ **目标用户 = vibe coder，不是纯小白。** 懂基础概念、能自己拿到 API Key，但看不懂代码、写不出来。产品职责是"用户用大白话指挥，代码对不对由 AI 自己测、自己给结论"。文档中任何"小白"字样都指此类 vibe coder，不是"不懂 git / 命令行的纯外行"。

## 🧭 产品真北（最高优先，开局先读这条，别跑偏）

**上下文 / 记忆是用户的资产，独立存在；模型 / 套餐 / app 都是围着它转、可随时热插拔的「工人」。换谁、为什么换，上下文纹丝不动。模型是临时工，上下文才是中心。**

- ❌ 不是"套壳 claude"，也不是 cc / cc switch 那种"只管切模型的开关"；✅ 是**真能陪用户把活干完的工作台**。
- ❌ 模型中心（"我接了哪个模型"）；✅ 上下文中心。claude 只是众多临时工之一。
- **第一用户 = 作者本人**：先要他自己天天用、用得顺、真能干完活。检验任何功能的尺子：「这能让我自己工作更顺吗？不能就别做。」
- **模型不限定**：作者实际在用大量且不固定的模型（Claude / GPT / Gemini / GLM / MiniMax / MiMo / Kimi / DeepSeek / Agnes-AI / 通义……），任何模型名都只是举例，产品支持**任意多、可自由增删**，绝不硬编码某几家。

### 作者的 4 个真实痛点（产品起点，详见方案文档 2.0 节）

1. **套餐限额拦腰截断 + 跨 app 丢上下文**：套餐有 5h/周额度，限额了换工具得从头重讲 → 上下文独立，限额时自动换模型/套餐无缝续，一个字都不用重讲。
2. **单模型自我认知幻觉**：单模型说服不了自己，要手动开别的 AI 反驳再汇总 → 内置多模型对弈（出方案 / 反驳 / 裁判）同台完成。
3. **全程强模型用不起，切便宜模型断记忆**：→ 按环节自动用合适且更省的模型（粗活便宜、精活才贵），切换不丢上下文（省钱 + 不断片必须同时成立）。
4. **配置与使用割裂**：改模型要去 cc switch 跨 app 填配置 → 所有模型/套餐一处配好，要切时点一下就行。

> 这 4 条是同一个病：上下文被锁死在「某模型 + 某套餐 + 某 app」，任何「想换」的理由都导致断片。真北就是解这个病。

完整方案文档（2026-06-22 已收口到项目内 `项目文档/`，全部文档归一处）：
- 文档路径：`/Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/项目文档/Cosmgrid-Agent-独立多模型AI工作平台完整方案.md`
- 文档版本：v0.9（2026-06-24 同步现状；进度横幅 v0.7-v0.9 全完成）
- 同目录还有：诚实审查报告 / 改进增强方案 / 竞品对比；`项目文档/归档文件/` 存使命已完成的历史规划与技术侦察
- ⚠️ `项目文档/` 已在 `.gitignore`（过程文档不入版本管理，本地保留）

## 进度与当前任务

> ⚠️ 进度以 git 提交历史为准（本段 2026-06-24 复核同步到 v0.9 / v0.7.5 Stable）。

- ✅ v0.1 数据底座
- ✅ v0.2 多模型对话 + workRoles（API 接入页 + 对话页 + Vercel AI SDK）
- ✅ v0.3 架构返工（Prisma + Hono server → `tauri-plugin-sql` 直连，实测可打包）+ 项目模板 / 套餐管理 + **全自动模型分配**
- ✅ v0.4 项目工作区端到端打通
  - ✅ v0.4.1 运行时回退链触发 + UsageEvent 落盘（修 ChatPage 切 fallback 写错 modelName 的 latent bug）
  - ✅ v0.4.2 模型路由器 v1 规则路由（ChatPage 智能推荐按钮）
  - ✅ v0.4.3 Token Plan 阈值提醒（`warningThresholds` 接 UI）
  - ✅ v0.4.4 项目工作区端到端打通 + openai-compatible provider
- ✅ v0.5 首次启动 4 步引导（OnboardingModal）+ 新建项目向导（2 步 + workspacePath）
- ✅ v0.6 长期记忆 + RAG（项目级记忆 + 跨项目关键词检索）
- ✅ v0.7 工具执行层 + CLI 引擎（吃订阅额度）
  - ✅ 4a 只读工具：read / glob / grep / git-read（+ `path-safety` 路径白名单）
  - ✅ 4b 写工具：write / edit / bash（+ `command-safety` 命令白名单 + 用户确认 + git 单文件快照回滚 + diagnostics 写后诊断）
  - ✅ CLI 引擎：Rust `spawn_cli_stream` spawn 本机 claude/codex，受控 env 隔离（抹掉 `ANTHROPIC_*`/`CLAUDECODE` 等污染前缀），实测吃订阅 5 小时额度；abort → `kill_cli` 真 SIGKILL 子进程
- ✅ v0.8 多模型对弈（`debate-engine`/`debate-runner`：出方案 / 反驳 / 裁判同台 + DebatePage + `debate-suggester` 在 ChatPage 检测复杂问题建议升级对弈）
- ✅ v0.9 智能省 token
  - ✅ SmartRouter v2：按真实表现评分路由 + 决策日志（评分门槛已从 30 样本死锁修为 1 + 贝叶斯收缩，见记忆 [[v0.9-stage7-smartrouter-spec]]）
  - ✅ 语义缓存（`semantic-cache`，关键词哈希 embedding 占位，transformers.js 真 embedding 留 v0.9.1）+ 抽取式上下文压缩（`context-compressor`，零 LLM 成本）
  - ✅ StatsPage 用量统计 + 隐式反馈学习 Step B（用户换更强模型 → 给上个模型记 `switched_up` 负反馈喂回评分）
- ✅ v0.7.5 Stable UI 美化（当前 About 页版本号）
- ✅ v0.9 后迭代（2026-06-24）：主对话多会话（侧栏切换/新建/删除 + 首条消息自动命名，分支 `feat/main-chat-multi-conversation`）；品牌 logo 换 dock 图标；i18n 清 31 个孤儿 key（559→528）；安全债 4 条全清；项目文档归一处整理（14 文档全在 `项目文档/`）

### 🔜 下一步（2026-06-24 复核，按「产品真北」+ 改进增强方案校准）

v0.7-v0.9 主线已落地。第一梯队改进（SmartRouter 去死锁 Step A+B / 写后类型检查 diagnostics / 对弈自动建议）**全做完了**。按 `项目文档/Cosmgrid-Agent-改进增强方案-2026-06-22.md`（已 06-24 刷新）：
- **真仍未做**：增强-4 MCP 接入口子；transformers.js 真 embedding（v0.9.1，现用关键词哈希保底）；Step B 其余采集点（重答/回滚/确认弹窗）；待办② 上下文护照条
- **明确不做**：bash sidecar / git worktree 隔离 / 技能市场（详见改进方案）
- **已知安全债（2026-06-24 代码实测复核，前一轮文档已过期）**：
  - ✅ ① API Key 仍是 [keystore.ts](app/src/lib/keystore.ts) 的 `cosmgrid-keys.json` 明文 JSON（非系统 keychain，文件本身明文）——但 Settings UI Badge 文案已改诚实为「本地明文文件」/「Local file」，i18n 残留的「keychain 插件」placeholder 也已改诚实。**真接 keychain 得换 `keyring` crate，留作可选增强，非阻塞。**
  - ✅ ② [App.tsx](app/src/App.tsx) `dbError` 故障页已正常渲染（`if (dbError)` 出图标+错误详情+reload 按钮），不再被吞
  - ✅ ③ SettingsPage「管理数据库」按钮已整个移除，`manageDb` i18n key 成孤儿（定义了无人引用），按钮债不存在
  - ✅ ④ 根目录 `vite_ssr_*.mjs` 调试垃圾已清空
  - **真现状：4 条全清，无阻塞安全债。** 下次若再写「已知债」，必须先 grep/Read 代码复核再落笔，避免文档过期骗自己

### ⚠️ 架构返工（v0.3，✅ 已完成，保留作技术坑记录）

v0.1/v0.2 用的「Prisma + 内嵌 Hono(Node) server」有**打包死局**：Prisma/Node 需运行时，Tauri 打包给用户的机器没有 Node，开发能跑、打包即崩。当时只验了 dev，没跑过 `tauri build`。

返工方案（已用 `spike-tauri-sql/` 实测打包成 4.8MB dmg 并读写落盘通过）：
- 数据库：Prisma → **`tauri-plugin-sql`**（底层 Rust sqlx，前端纯 TS，不写 Rust 业务逻辑）
- 架构：去掉 Hono server（3001 端口），前端经插件直连 SQLite
- API Key：明文传 + 假加密 → **`@tauri-apps/plugin-store` 独立 JSON 文件**（不入 SQLite 明文）。⚠️ **当初计划的"系统 keychain"并未落地**：实际是 [keystore.ts](app/src/lib/keystore.ts) 写 `cosmgrid-keys.json`，文件本身仍是明文（落 OS app-data 目录）。要真 keychain 得换 `keyring` crate——见上方「已知安全债」。
- 完成后**必须真跑 `pnpm tauri build` 验证产物可用**，不能只验 dev

### v0.3 验收标准
- `tauri build` 产出可双击运行的桌面 App，数据库读写落盘
- API Key 不入 SQLite 明文（走 `plugin-store` 独立文件；⚠️ 非系统 keychain，文件仍明文，UI 文案需同步纠正）
- tsc 通过、pnpm test 通过、覆盖率 ≥ 80%（✅ 2026-06-27 已达标：vitest **747 测试全过**（55 文件 / 13.9s），行 89% / 语句 87% / 分支 77% / 函数 87%，四阈值全过。db.ts 补了 node:sqlite 真跑集成测试 [db.integration.test.ts](app/src/lib/__tests__/db.integration.test.ts)，从 34% 提到 88%）

## 技术栈（v0.1 必须用）

- **桌面壳**：Tauri 2（不是 Electron，不是 Web）
- **前端**：React 18 + TypeScript
- **UI 库**：shadcn/ui + Tailwind
- **数据库**：SQLite（本地）
- **DB 访问**：`tauri-plugin-sql`（⚠️ 不用 Prisma，会打包死局；也不用 rusqlite 手写）
- **API Key**：`@tauri-apps/plugin-store` 独立 JSON 文件（不入 SQLite 明文）。⚠️ **不是系统 keychain**——store 文件本身明文，安全债已记录，勿再写"keychain"
- **包管理**：pnpm（注意：pnpm 11 的 build 批准在 `pnpm-workspace.yaml` 的 `allowBuilds: esbuild: true`，否则 `tauri build` 卡在依赖检查）

**package.json 起步**：直接抄 CC Switch 的依赖列表（路径 `/Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/技术参考/cc-switch-main/package.json`）

## 数据表（核心 13 张 + v0.6+ 新增 6 张 = 共 **19 张**；死表 conversation_model_snapshots 已删；建表 DDL 全在 [db.ts](app/src/lib/db.ts) `initSchema()`）

**资源层（4）**：providers / api_credentials / token_plans / models
**模板层（2）**：project_templates / project_template_roles
**任务层（4）**：projects / project_stages / conversations / messages（~~conversation_model_snapshots 死表已删~~）
**连续性层（2）**：checkpoints / handoff_packets（注意：字段是 `projectId`，不是 `taskId`）
**统计层（1）**：usage_events（字段也是 `projectId`）
**v0.6+ 新增（6）**：project_memories（长期记忆/RAG）/ model_performance_stats（SmartRouter 数据源）/ semantic_cache（语义缓存）/ debate_sessions（多模型对弈）/ tool_executions（工具执行审计）/ workspace_configs（工作区配置）

核心 14 张的完整字段定义见方案文档第 9 节；v0.6+ 6 张以 db.ts 的 DDL 为准。

## 借鉴项目（v0.1 主要）

- **CC Switch**（最重要）— Tauri 2 + React + shadcn/ui 技术栈 + Provider 抽象
  路径：`/Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/技术参考/cc-switch-main/`
- **OpenCode** — 多模型适配 + git snapshot
  路径：`/tmp/cosmgrid-research/opencode-dev/`
- **LiteLLM** — Provider 抽象 + 路由策略 + 集中定价 JSON
  路径：`/tmp/cosmgrid-research/litellm-litellm_internal_staging/`

## v0.1 不要做的事

- ❌ 不做 UI（v0.2 才做 API 接入页 + 对话页）
- ❌ 不做模型调用（v0.2 才接 Vercel AI SDK）
- ❌ 不做项目模板 UI（v0.3 才做）
- ❌ 不做项目工作区（v0.4 才做）
- ❌ 不引 Electron（用 Tauri 2）
- ❌ 不引 Rust 后端业务逻辑（Cosmgrid-Agent 是 TS 全栈）
- ❌ 不引 .NET / Python 依赖（除非通过 Vercel AI SDK 间接引入）

## v0.1 实施步骤（按顺序，⚠️ 历史记录，步骤 2/6/7 已被 v0.3 架构返工废弃，见上方"架构返工"一节）

1. `npm create tauri-app` 创建项目骨架（选 React + TypeScript）
2. ~~`pnpm add prisma @prisma/client`~~（已废弃，改用 `tauri-plugin-sql`）
3. `pnpm add ai @ai-sdk/anthropic @ai-sdk/openai @ai-sdk/google`（为 v0.2 准备）
4. `npx shadcn-ui@latest init`（抄 CC Switch 的 components.json）
5. 抄 CC Switch 的 package.json 依赖列表
6. ~~创建 `prisma/schema.prisma`~~（已废弃，改为 `src/lib/db.ts` 里的 `CREATE TABLE` DDL）
7. ~~`pnpm prisma migrate dev` 生成数据库~~（已废弃，改为 `initSchema()` 启动时建表）
8. 写 CRUD 函数（资源层 + 模板层 + 任务层的基础增删改查，直接在 `src/lib/db.ts` 里写，不经 server）
9. 写单测（参考规则 80% 覆盖率）
10. `pnpm tsc` + `pnpm test` 验证通过
11. `pnpm tauri dev` 验证开发环境跑通 + **必须再跑一次 `pnpm tauri build` 验证打包产物**

## 工作纪律

参考父级 `~/.claude/CLAUDE.md` 的所有规则，特别是：
- "行动项必须现在就做或明确说先不做，禁止'以后做'"
- "派完并行 agent 必须立刻用 TaskOutput 查所有状态"
- "推荐工具前先 `ls ~/.claude/{skills,agents,hooks}/` 看现状"
- "用户不懂技术，回答优先大白话 + 类比"
- "修改代码前必须先理解完整业务流程，先问流程、画数据流"
- "Bug 修复要先确认问题根源再改代码"

## 文档冲突点（重要！v0.1 实施时要避开）

- ❌ 不要建 Task 表（已被 Project 表替代，方案第 9 节已删）
- ❌ Checkpoint / HandoffPacket / UsageEvent 的字段是 `projectId`，不是 `taskId`
- ❌ "项目工作区"是新术语，不是"任务工作区"
- ❌ Model 表必填字段 `workRoles`（enum 数组）+ `capabilityScore`（JSON）
- ❌ 不用 Prisma / 不内嵌 Node server（见上方架构返工，会打包死局）
- ✅ 用户画像是 vibe coder（懂概念、能拿 API Key、看不懂代码），不是"不懂 git 的纯外行"

## 沟通风格

- 用大白话跟用户沟通（用户不懂代码）
- 重要决策要给清晰推荐，不要让用户在 N 个选项里反复选
- 任务完成要明确说"做完了"，不要"差不多"