# Cosmgrid-Agent

一个**多模型协作的 AI 工作台**桌面应用。

跟 Claude.app Code / Codex App / OpenCode App 同品类，但核心理念不同：

> **上下文 / 记忆是用户的资产，独立存在；模型、套餐、app 都是围着它转、可随时热插拔的「工人」。换谁、为什么换，上下文纹丝不动。**

它要解决的不是"接哪个模型"，而是作者本人每天踩的坑：套餐限额了换工具就得从头重讲、单个模型说服不了自己要手动开别的 AI 反驳、想用便宜模型省钱一切换记忆就断、改个模型还得跨应用去配置。完整的产品定位、4 个真实痛点与解法见项目文档里的 `Cosmgrid-Agent-独立多模型AI工作平台完整方案.md`，当前真实进度先看 `项目文档/Cosmgrid-Agent-当前状态与后续路线.md`。

> ⚠️ 模型不限定：产品支持任意多、可自由增删的模型（Claude / GPT / Gemini / GLM / MiniMax / MiMo / Kimi / DeepSeek / Agnes-AI / 通义……），任何模型名都只是举例，绝不硬编码某几家。

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面壳 | Tauri 2（不是 Electron，打包 ~5MB） |
| 前端 | React 19 + TypeScript 5.8 + Vite 7 |
| UI | shadcn/ui（radix-ui）+ Tailwind v4 |
| 数据库 | SQLite，经 `@tauri-apps/plugin-sql` 直连（底层 Rust sqlx，前端纯 TS，不写 Rust 业务逻辑） |
| API Key 存储 | `@tauri-apps/plugin-store`（本地 JSON，与数据库分离，库内不留明文。注：非严格系统 Keychain，是避免引入 Rust 业务逻辑的折中，安全性优于明文入库） |
| LLM 适配 | Vercel AI SDK（`ai` + `@ai-sdk/{anthropic,openai,google,react}`） |
| 测试 | Vitest（+ v8 coverage） |

> ⚠️ 不要用 Prisma 或内嵌 Node server——会导致 Tauri 打包死局（用户机器没有 Node 运行时），详见主方案文档第 0 节。

## 开发

```bash
# 安装依赖（用 pnpm）
pnpm install

# 纯前端开发（浏览器，不带 Tauri 壳）
pnpm dev

# 桌面开发（带 Tauri 壳，能用 SQLite / keychain 等原生能力）
pnpm tauri dev

# 类型检查 + 前端构建
pnpm build

# 跑测试
pnpm test

# 打包桌面产物（⚠️ 必须验证此步，不能只验 dev）
pnpm tauri build
```

## 目录结构

```
app/
├── src/                          # React 前端
│   ├── pages/                    # 页面
│   │   ├── ChatPage.tsx          #   对话页（主入口：多模型对话、工作文件夹、工作面板）
│   │   ├── ProvidersPage.tsx     #   API 接入 + 模型资源池
│   │   ├── UsageMonitorPage.tsx  #   用量监控（额度配置 + 用量明细）
│   │   ├── TemplatesPage.tsx     #   项目模板（角色→模型自动分配）
│   │   ├── ProjectsPage.tsx      #   项目资产（高级入口，保留旧资产）
│   │   ├── ProjectDetailPage.tsx #   项目资产详情（检查点 / 交接包 / 记忆等）
│   │   ├── SettingsPage.tsx      #   设置
│   │   └── OnboardingModal.tsx   #   首次启动引导
│   ├── components/               # 通用组件（shadcn/ui + 自定义）
│   │   ├── chat/                 #   左侧工具步骤卡、工作状态条
│   │   └── work-panel/           #   右侧协作链、只读 IDE、文件树、历史产出
│   ├── lib/
│   │   ├── db.ts                 #   tauri-plugin-sql 直连 SQLite，19 张表 CRUD
│   │   ├── keystore.ts           #   API Key 存取（plugin-store，不入库明文）
│   │   ├── api.ts               #   数据访问（schemas.ts 已删）
│   │   ├── templates.ts          #   内置项目模板
│   │   └── llm/                  #   LLM 适配层（provider-factory / cli-engine / smart-router / semantic-cache / debate / tools 等）
│   │       ├── provider-factory.ts      # provider 工厂 + 缓存（API 直连路径）
│   │       ├── cli-protocol.ts          # CLI 引擎协议层（纯逻辑可单测，JSONL 解析 + 受控 env）
│   │       ├── cli-engine.ts            # CLI 引擎 spawn 层（接 Rust spawn_cli_stream）
│   │       ├── model-capabilities.ts    # 模型能力知识库（自动识别 + 打分）
│   │       ├── checkpoint-generator.ts  # AI 自动生成检查点草稿
│   │       ├── chat-fallback.ts         # 回退链
│   │       ├── model-cooldown.ts        # 失败熔断
│   │       ├── cost-calculator.ts / model-prices.ts  # 成本计算
│   │       ├── usage-tracker.ts         # 用量回填
│   │       ├── plan-thresholds.ts       # 套餐阈值
│   │       └── error-classifier.ts / test-connection.ts
│   ├── App.tsx / main.tsx / index.css
│   └── lib/__tests__/            # 单元测试
├── src-tauri/                    # Tauri 2 桌面壳（Rust，插件配置 + spawn_cli_stream 命令，无 LLM 业务逻辑）
│   ├── capabilities/             #   插件权限
│   ├── src/ · Cargo.toml · tauri.conf.json
└── package.json
```

## 进度

按版本里程碑（详见主方案文档第 8 节）：

- ✅ **v0.1** 数据底座（14 张表 schema + CRUD）
- ✅ **v0.2** 多模型对话 + workRoles（API 接入页 + 对话页 + Vercel AI SDK）
- ✅ **v0.3** 架构返工（Prisma + Hono server → tauri-plugin-sql 直连，已实测可打包）+ 项目模板 / 套餐管理 + 全自动模型分配
- ✅ **v0.4** 项目工作区端到端打通（项目列表 / 详情 / 阶段 / 检查点）
- ✅ **v0.5** 首次启动引导 + 新建项目向导
- ✅ **v0.6** 长期记忆 + RAG（项目级记忆 + 跨项目关键词检索）
- ✅ **UI 美化** 整体视觉打磨
- ✅ **v0.7** 工具执行层 + CLI 引擎：只读工具（read/glob/grep/git-read）+ 写工具（write/edit/bash + 确认 + git 回滚）+ Rust `spawn_cli_stream` spawn 本机 claude/codex 吃订阅额度（abort → `kill_cli` SIGKILL）
- ✅ **v0.8** 多模型对弈（出方案/反驳/裁判同台 + DebatePage + ChatPage 自动建议）
- ✅ **v0.9** 智能省 token（SmartRouter v2 评分路由 + 语义缓存 + 上下文压缩 + StatsPage + 隐式反馈学习）
- ✅ **2026-06-24 后迭代** 主对话多会话（侧栏切换/新建/删除）、品牌 logo、i18n 清理、安全债全清、文档归一处
- ✅ **2026-06-28/29 大改收尾** 冗余入口整理、确认弹窗只做审批、右侧工作面板 v3.1、顶部多 AI 协作链、只读 IDE 内容展示、左侧步骤卡、新建对话清空旧工作面板状态

当前事实入口：

- `项目文档/00-项目文档索引.md`
- `项目文档/Cosmgrid-Agent-当前状态与后续路线.md`
- `项目文档/CosmGrid-Agent-Ui.md`

> 数据库表结构见主方案文档第 9 节；当前执行事实和后续路线以 `Cosmgrid-Agent-当前状态与后续路线.md` 为准。
