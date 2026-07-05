<img src="./项目图标/Cosmgrid-Ai-纯Logo-单块.svg" align="right" width="120" alt="Cosmgrid-Agent 标志" />

# Cosmgrid-Agent

**一个多模型协作的 AI 桌面工作台 —— 上下文是你的资产，模型是可随时换的工人。**

[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](#许可证)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![Status](https://img.shields.io/badge/status-早期开发-orange)](#项目状态)
[![Stars](https://img.shields.io/github/stars/<your-org>/Cosmgrid-Agent?style=social)](#stars)

[English](./README.md) | [简体中文](./README.zh-CN.md)

---

**Cosmgrid-Agent 是一个开源的多模型协作桌面 AI 工作台。** 它跟 Claude Code / Codex App / OpenCode App 同一品类，但押的方向不一样：

> **上下文（记忆、项目状态、工作产物）独立存在，跟任何模型、套餐、应用壳都不绑死。** 你换谁、用什么理由换，上下文都不会断片。

模型不限定：Claude / GPT / Gemini / GLM / MiniMax / MiMo / Kimi / DeepSeek / Agnes-AI / 通义等任意多家都支持，**绝不硬编码某几家**。产品面向 **vibe coder**：懂基础概念、能自己拿 API Key，但不会写代码的人。

[文档索引](#文档) · [Issue 反馈](https://github.com/<your-org>/Cosmgrid-Agent/issues) · [Discussion 讨论](https://github.com/<your-org>/Cosmgrid-Agent/discussions)

---

## 🌟 一句话亮点

- **真正省钱的智能路由** —— 默认行为：困难环节交给强模型（Opus / GPT-5 / Claude Sonnet 4.5 / Gemini 3 Pro 等），粗活交给便宜的国产模型（MiniMax / GLM / MiMo / Kimi / DeepSeek / 通义 / Qwen 等）。日常工作量下来常见可省 **40%–60% token 成本**（基于作者日常使用体感；具体每个工作场景的实测数字，待 `savings_events` 表导出统计后，以 StatsPage 为准）。
- **一个画布，多模型并行** — Claude / GPT / Gemini 任何几家在同一轮对话里并行跑，按需取最好的答案。
- **上下文独立层** — 项目记忆、检查点、交接包、工作产物是头等公民，模型怎么换它们都不动。
- **多模型对弈** — 单个模型说服不了自己时，对话内一键发起 **出方案 → 反驳 → 裁判** 三步循环。
- **一处配置所有模型** — 加、改模型在同一个页面完成，不用跨 app 改配置文件。
- **带护栏的本地工具** — 只读工具（read / glob / grep / git-read）免确认；写工具（write / edit / bash）**必须显式确认，且绑定工作区后可通过 git 回滚**。
- **桌面版 / 纯网页两栖** — 默认 Tauri 桌面壳（带 SQLite + 系统 keychain）；不想装 Tauri 也可直接 `pnpm dev` 跑纯前端。
- **本地优先、零 telemetry** — 你的 Key 存在 macOS Keychain / Windows Credential Manager / Linux Secret Service，不落明文文件。

---

## 🎯 为什么做这个？

4 个真实痛点其实是同一种病：**上下文被锁死在 "某个模型 + 某个套餐 + 某个 app" 这个三元组上，任何换的理由都导致断片。**

| # | 痛点 | 解法 |
| --- | --- | --- |
| 1 | 套餐限额了，换工具得从头重讲 | 上下文独立，限额时自动切模型无缝续，**一字不重讲** |
| 2 | 单模型说服不了自己 | 内置多模型对弈（出方案 / 反驳 / 裁判） |
| 3 | 强模型用不起，便宜模型切完记忆断片 | 按环节自动路由 + 切换不丢上下文 |
| 4 | 改模型要跨应用配置 | 一个页面配齐所有模型 / 套餐，点一下切 |

- ❌ **不是** 又一个 AI 套壳，也不是单纯的 "切模型开关"
- ✅ **是** 能陪用户把活干完的工作台
- ❌ 模型中心（"我接了哪家"）
- ✅ **上下文中心** —— 模型是临时工，上下文才是资产

---

## ✨ 现在已经能做什么（截至 2026-07-04）

| 里程碑 | 状态 | 真实能力 |
| --- | --- | --- |
| v0.1 数据底座 | ✅ | 19 张 SQLite 表 + 完整 CRUD（资源 / 模板 / 任务 / 连续性 / 统计 + 6 张扩展） |
| v0.2 多模型对话 | ✅ | API 接入页 + 对话页，Vercel AI SDK 接多模型 |
| v0.3 架构返工 | ✅ | Prisma → `tauri-plugin-sql`（实测可打包 4.8 MB dmg） |
| v0.4 项目工作区 | ✅ | 项目列表 / 详情 / 阶段 / 检查点 端到端 |
| v0.5 首次启动引导 | ✅ | OnboardingModal + 新建项目向导 |
| v0.6 长期记忆 + RAG | ✅ | 项目级记忆 + 跨项目关键词检索 |
| v0.7 工具执行层 / CLI 引擎 | ✅ | 只读工具（read / glob / grep / git-read）；写工具（write / edit / bash — **需确认 + git 回滚**）；Rust `spawn_cli_stream` 调度本机 Claude / Codex CLI 吃订阅额度，abort → `kill_cli` SIGKILL |
| v0.8 多模型对弈 | ✅ | 出方案 / 反驳 / 裁判同台 + 对话内触发 + 自动建议 |
| v0.9 智能省 token | ✅ | SmartRouter v2 评分路由 + 语义缓存 + 上下文压缩 + StatsPage + 隐式反馈学习 |
| 2026-06-28/29 收尾 | ✅ | 主对话多会话（侧栏切 / 新建 / 删）+ 品牌 logo + 右侧工作面板 v3.1 + 顶部多 AI 协作链 + 左侧步骤卡 + 安全债清零 |

---

## 🚧 现在的边界（诚实的边界）

- **早期开发，没有 stable tag**：v0.1–v0.9 全部落地，但还没发 1.0 production；README 里描述的功能可能略领先于某次改动的合并节奏。
- **macOS 是主战场**：本机完整可用；Windows / Linux 走过路径但还没大规模社区回归，不保证开箱即用。
- **你带自己的 key**：本应用不内置任何模型厂商的 Key；自己去对应厂商申请，从 Providers 页面填进去。
- **本地构建需要 Rust 工具链**：跑 `pnpm tauri dev` 或 `tauri build` 要本地有 Rust；只跑 `pnpm dev` 纯前端版不需要。

---

## 📦 安装

### 桌面应用程序（BETA）

> ⚠️ 提前说：现在还没有签名后的二进制，发布出来的下载件属 "社区版构建"。要正式签名件请等后续 stable tag。

| 平台 | 安装包 |
| --- | --- |
| macOS (Apple Silicon) | `Cosmgrid-Agent_x.y.z_aarch64.dmg` |
| macOS (Intel) | `Cosmgrid-Agent_x.y.z_x64.dmg` |
| Windows | `Cosmgrid-Agent_x.y.z_x64-setup.exe` |
| Linux | `.deb` / `.rpm` / `.AppImage` |

下载：<https://github.com/<your-org>/Cosmgrid-Agent/releases>

### 从源码构建

```bash
git clone https://github.com/<your-org>/Cosmgrid-Agent.git
cd Cosmgrid-Agent/app

# 环境：Node.js 18+ · pnpm 11+ · Rust 工具链（仅桌面构建需要）
pnpm install

# 纯前端开发（浏览器，无原生能力）
pnpm dev

# 桌面开发（推荐 —— 能用 SQLite / keychain / 文件系统）
pnpm tauri dev

# 打包桌面产物（⚠️ 必跑这步，dev 能跑不算数）
pnpm tauri build
```

> Tauri 2 在 macOS / Windows / Linux 三端打包行为有差异；产物（`dmg` / `msi` / `deb|rpm|AppImage`）会落在 `app/src-tauri/target/release/bundle/` 下。

---

## 🚀 快速开始（TL;DR）

1. **加 API Key**：打开 *Providers* → *Add provider* → 粘贴 Key。Key 进系统 keychain，**不写 SQLite 不写明文文件**。
2. **建项目**：*Projects* → *New*。可选：从模板新建，自动按角色分配模型。
3. **开聊**：对话页选模型，发消息。在对话里 `@其他模型` 同台，敲 **D** 触发多模型对弈。
4. **绑工作文件夹**：右面板绑一个目录；Cosmgrid-Agent 之后会在这个目录里用工具（read / grep / edit / bash），diff 在面板里直接展示。

新手详细步骤：见 [用户向文档](./项目文档/00-项目文档索引.md)（仅本地仓库内，不推送）。

---

## 🔧 配置

- **API Key 存储**：`keystore.ts` 包了 Rust `keyring` 命令。macOS = Keychain，Windows = Credential Manager，Linux = Secret Service；旧 `cosmgrid-keys.json` 明文文件有自动迁移逻辑，迁完会逐条删旧条目。
- **工作区根目录**：Tauri 按 OS 约定在用户配置目录下开一个；SQLite 也存在那里。
- **模型注册表**：Providers 页是唯一可信源，决定当前能调用到哪些模型。

最小配置示例：

```jsonc
// ~/.cosmgrid-agent/config.json（高级用户，多数情况不需要手写）
{
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "fallbackChain": ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
  "theme": "system"
}
```

---

## 🛡️ 默认安全行为

对话和工具都跑在你自己机器上，默认：

- **只读工具**（read / glob / grep / git-read）—— **免确认直接跑**。
- **写工具**（write / edit / bash）—— **每一步都要在对话 UI 里显式确认**；可逆性来自工作区里的 git 绑定。
- **bash** —— 默认只能跑在工作区目录里；越界命令需要二次确认。
- **订阅版 CLI 智能体**（Claude Code / Codex 之类的外壳）—— 通过 `spawn_cli_stream` 起，**abort 立刻通过 `kill_cli` SIGKILL 干掉整个进程组**，不留僵尸进程。
- **本地优先** —— 不采集分析数据、不打点、不发送你配的模型厂商之外的请求。

---

## 🛠️ 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | **Tauri 2**（不是 Electron；macOS 打包实测约 4.8 MB） |
| 前端 | **React 19** + **TypeScript 5.8** + **Vite 7** |
| UI | **shadcn/ui**（radix-ui）+ **Tailwind v4** |
| 数据库 | **SQLite 3**，经 `@tauri-apps/plugin-sql` 直连（底层 Rust sqlx；前端纯 TS，**不写 Rust 业务逻辑**） |
| Key 存储 | 系统凭据库（macOS Keychain / Windows Credential Manager / Linux Secret Service），经 Rust `keyring` 命令访问 |
| LLM 适配 | **Vercel AI SDK 6**（`ai` + `@ai-sdk/{anthropic,openai,google}`） |
| 工具执行 | 本地 **read / glob / grep / git-read** + 带护栏的 **write / edit / bash**；Rust `spawn_cli_stream` 调度订阅版 Claude / Codex CLI |
| 测试 | **Vitest** + v8 coverage（门槛：`lines/functions/statements 80%`，`branches 75%`） |
| 包管理 | **pnpm 11** |

> ⚠️ **不用 Prisma，也不用内嵌 Node server** —— 用户机器上没有 Node 运行时，Tauri 打包会死。这是 v0.3 架构返工专门解决的坑。

---

## 📁 目录结构

```
Cosmgrid-Agent/
├── README.md                  ← 你正在看（项目主介绍，英文）
├── README.zh-CN.md            ← 中文版本
├── AGENTS.md                  ← 项目级 AI 助手指令（Claude Code / Codex 共用）
├── app/                       ← 主工程（Tauri + React）
│   ├── README.md              ← 开发者文档（架构 / 模块 / 命令）
│   ├── src/                   ← React 前端
│   │   └── pages/chat/        ← 主对话页（7 个单一职责 hook）
│   ├── src-tauri/             ← Tauri 桌面壳（Rust：插件配置 + spawn_cli_stream）
│   └── package.json
├── docs/                      ← 公开文档（验证记录等）
├── 项目图标/                   ← Logo 源文件（5 个候选，命名待统一）
└── 项目文档/                   ← 内部过程文档（gitignore，不上传仓库）
```

开发者向的细节（模块边界、`lib/db/` 拆出的 12 个领域文件、`lib/llm/` 适配层结构）在 [`app/README.md`](./app/README.md)。

---

## 🧑‍💻 参与贡献

- **Issue / PR**：欢迎。提 PR 前先看 [`AGENTS.md`](./AGENTS.md) 了解项目协作规则。
- **可复现的 bug 反馈**：附路径 + `app/coverage/` / `app/test-artifacts/` 下相关日志 + 当前版本号；纯 "它不工作了" 描述很难定位。
- **品牌 / Logo**：`项目图标/` 5 个候选需要定一个**主 logo**，并统一改成 `Cosmgrid-Agent` 前缀（见 [项目状态](#项目状态)）。

### 开发者命令速查

```bash
# 类型检查 + 前端构建
cd app && pnpm build

# 跑单测 + 覆盖率（门槛 80%）
pnpm test
pnpm test:coverage

# 桌面打包（这是真正的端到端验证）
pnpm tauri build

# 桌面调试：直连 SQLite 看数据
sqlite3 ~/Library/Application\ Support/cosmgrid-agent/cosmgrid.db
```

---

## 📜 许可证

[MIT](./LICENSE) —— 首次发布时会随仓库一起加上 `LICENSE` 文件。

---

## ⚠️ 项目状态

- 当前是早期版本，没有 stable release tag。功能全集在内部方案文档里有，但仓库不携带；**以仓库代码 + 本 README 为准**。
- `项目图标/` 目录下 5 个 SVG 文件名都还沿用旧的 `Cosmgrid-Ai-` 前缀，跟新项目名 `Cosmgrid-Agent` 暂未统一；等确定主 logo 后会做一次 rename 收口。
- 内部过程文档（`项目文档/`）在 `.gitignore`，不推送仓库。对外的架构 / 产品定位以 `app/README.md` 和本 README 为准。
- 作者本人日常用 macOS；Windows / Linux 走过路径但还欠系统性社区回归。在这两个 OS 上碰到问题请带 **平台 + 版本** 详情开 issue。
