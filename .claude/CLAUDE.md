# Cosmgrid-Agent — Claude Code 项目指令

## 项目定位
多模型 AI 编程桌面工具。跟 Claude.app Code / Codex App / OpenCode App 同一品类，差异化是"多 AI 协作 + 任务流可视化 + 小白友好"。

完整方案文档：
- 文档路径：`/Users/shaoyitong/Desktop/Cosmgrid-Agent-独立多模型AI工作平台完整方案.md`
- 文档版本：v0.3 完善版（2178 行，14 ## 章节，93 ### 子章节）

## 进度与当前任务

- ✅ v0.1 数据底座（2026-06-18）
- ✅ v0.2 对话 + workRoles（2026-06-19）
- ✅ v0.3 第一步：架构返工（2026-06-19 完成）
- 🔧 **v0.3 第二步：模板 + 资源管理（2026-06-19 进行中，见下方拆解）**
  - ✅ 项目模板页（4 个内置模板 + 自定义模板 + 角色→模型分配 + fallback 模型 + "另存为我的模板"）
  - ✅ Token Plan 页（添加套餐、总额度/已用额度、恢复周期）
  - ⏳ 模板回退链的**运行时触发**（401/429/超时自动切 fallback）——没做，因为目前还没有"项目执行"这个概念去触发它，留到 v0.4 项目工作区一起做
  - ⏳ 模型路由器 v1 规则路由（4.6 节）——同上，依赖"任务"概念，留到 v0.4
  - ⏳ Token Plan 阈值提醒的 UI 弹窗——字段已存（`warningThresholds`），暂未接提醒逻辑

### ⚠️ 架构返工（v0.3 最优先，已实测验证方案）

v0.1/v0.2 用的「Prisma + 内嵌 Hono(Node) server」有**打包死局**：Prisma/Node 需运行时，Tauri 打包给用户的机器没有 Node，开发能跑、打包即崩。当时只验了 dev，没跑过 `tauri build`。

返工方案（已用 `spike-tauri-sql/` 实测打包成 4.8MB dmg 并读写落盘通过）：
- 数据库：Prisma → **`tauri-plugin-sql`**（底层 Rust sqlx，前端纯 TS，不写 Rust 业务逻辑）
- 架构：去掉 Hono server（3001 端口），前端经插件直连 SQLite
- API Key：明文传 + 假加密 → **系统 keychain**（tauri keychain 插件）
- 完成后**必须真跑 `pnpm tauri build` 验证产物可用**，不能只验 dev

### v0.3 验收标准
- `tauri build` 产出可双击运行的桌面 App，数据库读写落盘
- API Key 存在系统 keychain，不入库明文
- tsc 通过、pnpm test 通过、覆盖率 ≥ 80%

## 技术栈（v0.1 必须用）

- **桌面壳**：Tauri 2（不是 Electron，不是 Web）
- **前端**：React 18 + TypeScript
- **UI 库**：shadcn/ui + Tailwind
- **数据库**：SQLite（本地）
- **DB 访问**：`tauri-plugin-sql`（⚠️ 不用 Prisma，会打包死局；也不用 rusqlite 手写）
- **API Key**：存系统 keychain（不入库明文）
- **包管理**：pnpm（注意：pnpm 11 的 build 批准在 `pnpm-workspace.yaml` 的 `allowBuilds: esbuild: true`，否则 `tauri build` 卡在依赖检查）

**package.json 起步**：直接抄 CC Switch 的依赖列表（路径 `/Users/shaoyitong/Desktop/开发/Cosmgrid-Agent/技术参考/cc-switch-main/package.json`）

## 14 张数据表（按 5 层组织，资源层 → 模板层 → 任务层 → 连续性层 → 统计层）

**资源层（4）**：Provider / ApiCredential / TokenPlan / Model
**模板层（2）**：ProjectTemplate / ProjectTemplateRole
**任务层（5）**：Project / ProjectStage / Conversation / ConversationModelSnapshot / Message
**连续性层（2）**：Checkpoint / HandoffPacket（注意：字段是 `projectId`，不是 `taskId`）
**统计层（1）**：UsageEvent（字段也是 `projectId`）

完整字段定义见方案文档第 9 节。

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