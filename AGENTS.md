# Cosmgrid-Agent — 项目指令（Claude Code / Codex 共用，唯一正本）

> 本文件是本项目唯一维护的 AI 编程助手指令，`.claude/CLAUDE.md` 只是一行导入，不要再分开改两份。

## 项目定位
多模型 AI 编程桌面工具。跟 Claude Code / Codex App / OpenCode App 同一品类，差异化是"多 AI 协作 + 任务流可视化 + 对 vibe coder 友好"。

> ⚠️ **目标用户 = vibe coder，不是纯小白。** 懂基础概念、能自己拿到 API Key，但看不懂代码、写不出来。产品职责是"用户用大白话指挥，代码对不对由 AI 自己测、自己给结论"。文档中任何"小白"字样都指此类 vibe coder，不是"不懂 git / 命令行的纯外行"。

## 🧭 产品真北（最高优先，开局先读这条，别跑偏）

**上下文 / 记忆是用户的资产，独立存在；模型 / 套餐 / app 都是围着它转、可随时热插拔的「工人」。换谁、为什么换，上下文纹丝不动。模型是临时工，上下文才是中心。**

- ❌ 不是"套壳某个 AI 工具"，也不是 cc / cc switch 那种"只管切模型的开关"；✅ 是**真能陪用户把活干完的工作台**。
- ❌ 模型中心（"我接了哪个模型"）；✅ 上下文中心。Claude / Codex / 任何模型都只是众多临时工之一。
- **第一用户 = 作者本人**：先要他自己天天用、用得顺、真能干完活。检验任何功能的尺子：「这能让我自己工作更顺吗？不能就别做。」
- **模型不限定**：作者实际在用大量且不固定的模型（Codex / GPT / Gemini / GLM / MiniMax / MiMo / Kimi / DeepSeek / Agnes-AI / 通义……），任何模型名都只是举例，产品支持**任意多、可自由增删**，绝不硬编码某几家。

### 作者的 4 个真实痛点（产品起点，详见方案文档 2.0 节）

1. **套餐限额拦腰截断 + 跨 app 丢上下文**：套餐有 5h/周额度，限额了换工具得从头重讲 → 上下文独立，限额时自动换模型/套餐无缝续，一个字都不用重讲。
2. **单模型自我认知幻觉**：单模型说服不了自己，要手动开别的 AI 反驳再汇总 → 内置多模型对弈（出方案 / 反驳 / 裁判）同台完成。
3. **全程强模型用不起，切便宜模型断记忆**：→ 按环节自动用合适且更省的模型（粗活便宜、精活才贵），切换不丢上下文（省钱 + 不断片必须同时成立）。
4. **配置与使用割裂**：改模型要去 cc switch 跨 app 填配置 → 所有模型/套餐一处配好，要切时点一下就行。

> 这 4 条是同一个病：上下文被锁死在「某模型 + 某套餐 + 某 app」，任何「想换」的理由都导致断片。真北就是解这个病。

当前文档入口（2026-07-04 收口到 6 类文件，后续先读这份）：
- 索引：`/Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/项目文档/00-项目文档索引.md`（先看这份，决定去看哪一份）
- 长期总方案（架构文档）：`/Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/项目文档/Cosmgrid-Agent-独立多模型AI工作平台完整方案.md`——⚠️ 2026-07-04 核实后确认新旧混杂，先看文档顶部的核实结论横幅
- 关键技术文档：`/Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/项目文档/Cosmgrid-Agent-关键技术文档.md`——每层用什么技术、完善度、参考项目对照，2026-07-04 逐代码核实，当前最准确
- 待办清单：`/Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/项目文档/剩余问题汇总-2026-07-03.md`——唯一权威待办来源（原"当前状态与后续路线.md"已归档，别再引用那份）
- UI 规范：`/Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/项目文档/CosmGrid-Agent-Ui.md`
- 打开方式：`/Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/项目文档/应用打开方式.md`

文档纪律：
- `项目文档/` 根目录**只保留上面 6 类文件**，其余全部归档到 `项目文档/归档文件/`，桌面不再放散落过程稿。
- 给用户看先看"00-项目文档索引"；给 AI 查历史依据再进归档。
- ⚠️ `项目文档/` 已在 `.gitignore`（过程文档不入版本管理，本地保留）。

**文档同步纪律**（改代码时对照检查，照抄 Turborepo AGENTS.md 的做法，别只是笼统说"记得更新文档"）：
- 改了任何一层的技术实现（LLM 接入/工具/记忆/意图判断/编排等）→ 检查 `Cosmgrid-Agent-关键技术文档.md` 对应章节的技术描述和完善度判断是不是还准。
- 完成或新发现一项待办 → 更新 `剩余问题汇总-2026-07-03.md`，不要另开新汇总文件。
- 产品定位/差异化策略变了 → 更新 `Cosmgrid-Agent-独立多模型AI工作平台完整方案.md` §1（其余章节已知过时，不用管）。
- 过程稿/方案稿写完执行完 → 当天归档到 `项目文档/归档文件/`，不留在桌面或项目文档根目录。

## 进度与当前任务

> ⚠️ **详细当前进度、下一步优先级、非阻塞问题，一律以 `项目文档/剩余问题汇总-2026-07-03.md` 为准**（原"当前状态与后续路线.md"已于 2026-07-04 归档，不再是当前入口，别再引用它）——这里不再重复维护一份进度快照，避免两处又分叉。这里只留几条几乎不会变的稳定事实：

- 大版本线：v0.1 数据底座 → v0.2 多模型对话 → v0.3 架构返工（`tauri-plugin-sql`）→ v0.4 项目工作区 → v0.5 首次启动引导 → v0.6 长期记忆/RAG → v0.7 工具执行层/CLI 引擎 → v0.8 多模型对弈 → v0.9 智能省 token → 2026-06-28/29 大改（收敛为"以对话页为中心，工作文件夹绑定对话，右侧工作面板展示执行"）。全部已完成，具体子项和后续每轮进展见上面那份当前状态文档。
- 多模型对弈（debate）已经是**对话内触发**（`ChatPage` 里嵌，`debate-engine`/`debate-runner`/`debate-suggester`），不是独立页面——早期做过独立 `DebatePage`，已被删除（commit `447d9e0`），别再往"要不要做 DebatePage"方向想。
- API Key 已从明文 JSON 迁移到**系统凭据库**（Rust `keyring`：macOS Keychain / Windows Credential Manager / Linux Secret Service），`keystore.ts` 只保留旧 `cosmgrid-keys.json` 的只读迁移逻辑（迁移成功即删旧条目）。2026-07-04 复核 `Cargo.toml`（`keyring = "4.1.2"`）和 `keystore.ts`（`invoke("save_api_key"...)`）确认属实，无阻塞安全债。
- 测试覆盖率门槛：**80%**（`vitest.config.ts`：lines/functions/statements 80，branches 75）——不是 90%，别把别处看到的数字抄过来。

### ⚠️ 架构返工（v0.3，✅ 已完成，保留作技术坑记录）

v0.1/v0.2 用的「Prisma + 内嵌 Hono(Node) server」有**打包死局**：Prisma/Node 需运行时，Tauri 打包给用户的机器没有 Node，开发能跑、打包即崩。当时只验了 dev，没跑过 `tauri build`。

返工方案（已用 `spike-tauri-sql/` 实测打包成 4.8MB dmg 并读写落盘通过）：
- 数据库：Prisma → **`tauri-plugin-sql`**（底层 Rust sqlx，前端纯 TS，不写 Rust 业务逻辑）
- 架构：去掉 Hono server（3001 端口），前端经插件直连 SQLite
- API Key：明文传 + 假加密 → **系统凭据库**（Rust `keyring`，不入 SQLite 明文；旧 `cosmgrid-keys.json` 只作为升级迁移来源，迁移成功后逐条删除）
- 完成后**必须真跑 `pnpm tauri build` 验证产物可用**，不能只验 dev

## 技术栈（v0.1 必须用）

- **桌面壳**：Tauri 2（不是 Electron，不是 Web）
- **前端**：React 18 + TypeScript
- **UI 库**：shadcn/ui + Tailwind
- **数据库**：SQLite（本地）
- **DB 访问**：`tauri-plugin-sql`（⚠️ 不用 Prisma，会打包死局；也不用 rusqlite 手写）
- **API Key**：系统凭据库（Rust `keyring`，macOS Keychain / Windows Credential Manager / Linux Secret Service），不入 SQLite 明文；`@tauri-apps/plugin-store` 只保留用于旧 `cosmgrid-keys.json` 迁移读取。
- **包管理**：pnpm（注意：pnpm 11 的 build 批准在 `pnpm-workspace.yaml` 的 `allowBuilds: esbuild: true`，否则 `tauri build` 卡在依赖检查）

**package.json 起步**：直接抄 CC Switch 的依赖列表（路径 `/Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/技术参考/cc-switch-main/package.json`）

## 数据表（核心 13 张 + v0.6+ 新增 6 张 = 共 **19 张**；2026-06-22 删死表 conversation_model_snapshots；建表 DDL 已拆分到 `app/src/lib/db/schema.ts`，不再是单一 `db.ts` 里的 `initSchema()`）

**资源层（4）**：providers / api_credentials / token_plans / models
**模板层（2）**：project_templates / project_template_roles
**任务层（4）**：projects / project_stages / conversations / messages（~~conversation_model_snapshots 死表已删~~）
**连续性层（2）**：checkpoints / handoff_packets（注意：字段是 `projectId`，不是 `taskId`）
**统计层（1）**：usage_events（字段也是 `projectId`）
**v0.6+ 新增（6）**：project_memories（长期记忆/RAG）/ model_performance_stats（SmartRouter 数据源）/ semantic_cache（语义缓存）/ debate_sessions（多模型对弈）/ tool_executions（工具执行审计）/ workspace_configs（工作区配置）

核心 13 张的完整字段定义见方案文档第 9 节；v0.6+ 6 张以 `app/src/lib/db/schema.ts` 的 DDL 为准。

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
9. 写单测（覆盖率门槛见 `app/vitest.config.ts`，当前 80%）
10. `pnpm tsc` + `pnpm test` 验证通过
11. `pnpm tauri dev` 验证开发环境跑通 + **必须再跑一次 `pnpm tauri build` 验证打包产物**

## 工作纪律

通用工作方式（怎么派 agent、怎么验证、怎么跟用户沟通等）由全局配置统一管理（Claude Code 走 `~/.claude/CLAUDE.md` + `~/.claude/rules/zh/`；Codex 走对应的全局配置），本文件不重复罗列，避免和全局内容脱节。这里只保留本项目专属的规则（见下面"文档冲突点"和"沟通风格"）。

### 别把代码堆回大文件（防止 ChatPage.tsx / db.ts 回潮）

这不是抽象原则，是这个项目真实撞过的坑：`ChatPage.tsx` 曾经涨到 1944 行、`db.ts` 曾经是 4000+ 行的单体文件，都是靠专门一轮重构才拆掉的（分别拆成 `app/src/pages/chat/` 下 7 个职责单一的 hook、`app/src/lib/db/` 下 12 个领域文件）。加新功能时：

- **不要**往 `ChatPage.tsx`、`db.ts`、`chat-fallback.ts`、`orchestrator.ts` 这类已经拆过一轮或体量较大的文件里继续堆新逻辑——新状态/新流程优先建新 hook 或新模块，参照 `app/src/pages/chat/useChatStream.ts` 这类"单一职责"的现成范例。
- **不要**新造一个跟已有工具/领域文件功能重叠的平行实现——新表的 CRUD 放进 `app/src/lib/db/` 对应领域文件（或新建一个），不要退回到往 `db.ts` 本体里加函数。
- 单文件超过 800 行就是危险信号（跟全局 `coding-style.md` 的"文件聚焦 <800 行"一致），发现时应该主动提出拆分，不用等用户要求。

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
