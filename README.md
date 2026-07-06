<img src="./项目图标/Cosmgrid-Ai-纯Logo-单块.svg" align="right" width="120" alt="Cosmgrid-Agent logo" />

# Cosmgrid-Agent

**A multi-model AI desktop workbench — your context is the asset; your models are swappable workers.**

[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![Status](https://img.shields.io/badge/status-early%20development-orange)](#project-status)
[![Stars](https://img.shields.io/github/stars/<your-org>/Cosmgrid-Agent?style=social)](#stars)

[English](./README.md) | [简体中文](./README.zh-CN.md)

---

**Cosmgrid-Agent is an open-source multi-model AI desktop workbench.** It sits in the same category as Claude Code, Codex App, and OpenCode App — but it takes a different bet:

> **Your context (memory, project state, work artifacts) lives independently of any model, plan, or app shell.** You can swap who runs it, or why you swapped, and the context never breaks.

Bring your own API key for any of: Claude, GPT, Gemini, GLM, MiniMax, MiMo, Kimi, DeepSeek, Agnes-AI, Tongyi, and more — **no model is hard-coded**. The product is designed for **vibe coders**: developers who understand core concepts and can fetch their own keys, but don't write code themselves.

[Docs](#documentation) · [Project index](./项目文档/00-项目文档索引.md) (local-only) · [Issue tracker](https://github.com/<your-org>/Cosmgrid-Agent/issues) · [Discussions](https://github.com/<your-org>/Cosmgrid-Agent/discussions)

---

## 🌟 Highlights

- **Smart routing that actually saves you money** — by default, hard tasks go to strong models (Opus / GPT-5 / Claude Sonnet 4.5 / Gemini 3 Pro) while coarse work gets routed to cheaper ones (MiniMax / GLM / MiMo / Kimi / DeepSeek / Tongyi / Qwen). On typical day-to-day workloads, users report **40%–60% less token cost** compared with using a single flagship model end-to-end. *(Numbers are based on author daily-use impression; concrete figures per workload will be exported from the `savings_events` table → StatsPage as soon as a benchmark run is collected.)*
- **Multi-model collaboration on one canvas** — run a single conversation across Claude, GPT, Gemini, and any other provider, all in parallel; pick the best answer per turn.
- **Independent context layer** — your project memory, checkpoints, handoff packets, and work artifacts are first-class citizens; they don't move when you swap models.
- **Built-in multi-model debate** — when a single model can't convince itself, spin up an **advocate → critic → judge** loop inside the chat.
- **One place to configure any provider** — add/edit a model or plan in one screen, no cross-app config file edits.
- **Native tools with guardrails** — read tools (read / glob / grep / git-read) run freely; write tools (write / edit / bash) **require explicit confirmation and are reversible via git rollback**.
- **Desktop app or web fallback** — Tauri-based desktop with SQLite + system keychain; pure-web dev mode works without Tauri if you just want to poke at the UI.
- **Local-first, no telemetry** — your keys live in macOS Keychain / Windows Credential Manager / Linux Secret Service, not in a plaintext file.

---

## 🎯 Why Cosmgrid-Agent?

The four pain points we built it around are really one disease: **your context is locked to a specific (model + plan + app) tuple, and any reason to swap causes an amnesia event.**

| # | Pain | Solution |
| --- | --- | --- |
| 1 | Hit a plan quota, switch tools, retell the whole story | Context is independent; auto-switch on quota — **never retell** |
| 2 | A single model can't convince itself | Built-in multi-model debate (advocate / critic / judge) |
| 3 | Strong models are too expensive, cheap models drop memory | Per-step auto-routing + zero-memory-loss switching |
| 4 | Changing a model means editing config in another app | All providers / plans configured in one place, one click to switch |

- ❌ **Not** "yet another AI shell" or a "model switcher"
- ✅ **A workbench that helps you finish the job**
- ❌ Model-centric ("which model did I plug in?")
- ✅ **Context-centric** — models are replaceable workers; your context is the asset

---

## ✨ What's already working (as of 2026-07-04)

| Milestone | Status | What it does |
| --- | --- | --- |
| v0.1 Data layer | ✅ | 19 SQLite tables + full CRUD across resources / templates / tasks / continuity / stats + 6 extension tables |
| v0.2 Multi-model chat | ✅ | API connection page + chat page; Vercel AI SDK bridging Claude / GPT / Gemini |
| v0.3 Architecture rework | ✅ | Prisma → `tauri-plugin-sql` (verified packagable as a 4.8 MB macOS dmg) |
| v0.4 Project workspace | ✅ | Project list / detail / stage / checkpoint end-to-end |
| v0.5 Onboarding | ✅ | First-run modal + new-project wizard |
| v0.6 Long-term memory + RAG | ✅ | Project-level memory + cross-project keyword retrieval |
| v0.7 Tool layer / CLI engine | ✅ | Read tools (read / glob / grep / git-read); write tools (write / edit / bash — **confirmation + git rollback**); Rust `spawn_cli_stream` to drive local Claude / Codex binaries (consumes subscription; abort → `kill_cli` SIGKILL) |
| v0.8 Multi-model debate | ✅ | Advocate / critic / judge in-chat with auto-suggest |
| v0.9 Smart token savings | ✅ | SmartRouter v2 with score-based routing + semantic cache + context compression + StatsPage + implicit feedback learning |
| 2026-06-28/29 polish | ✅ | Multi-session sidebar + brand logo + right work-panel v3.1 + top collaboration chain + left step-card + security-debt cleanup |

---

## 🚧 Current boundaries

- **Early development, no stable tag yet.** All v0.1–v0.9 milestones are landed, but no production 1.0 release. Some docs may describe functionality slightly ahead of any given commit.
- **macOS is the primary target.** Full validation done locally on macOS; Windows / Linux paths have been exercised but need broader community verification — not guaranteed out-of-the-box yet.
- **You bring your own keys.** No model provider key is shipped with this app. Get one from your provider of choice and add it via the Providers page.
- **Native build needs Rust toolchain.** `pnpm tauri dev` / `tauri build` requires a local Rust install. Pure-web `pnpm dev` does not.

---

## 📦 Install

### Desktop application (BETA)

> Heads up: no signed binaries are shipped yet — current builds are developer-signed or unsigned. Treat early downloads as community builds.

| Platform | File |
| --- | --- |
| macOS (Apple Silicon) | `Cosmgrid-Agent_x.y.z_aarch64.dmg` |
| macOS (Intel) | `Cosmgrid-Agent_x.y.z_x64.dmg` |
| Windows | `Cosmgrid-Agent_x.y.z_x64-setup.exe` |
| Linux | `.deb` / `.rpm` / `.AppImage` |

Releases: <https://github.com/<your-org>/Cosmgrid-Agent/releases>

### Build from source

```bash
git clone https://github.com/<your-org>/Cosmgrid-Agent.git
cd Cosmgrid-Agent/app

# Runtime: Node.js 18+ · pnpm 11+ · Rust toolchain (only for desktop builds)
pnpm install

# Pure-web dev (browser, no native capability)
pnpm dev

# Desktop dev (recommended — SQLite, keychain, FS)
pnpm tauri dev

# Build a desktop installer (⚠️ verify this — `tauri dev` passing is not enough)
pnpm tauri build
```

> Cross-platform Tauri builds differ per OS. macOS / Windows / Linux produce different artifacts (`dmg` / `msi` / `deb|rpm|AppImage`) under `app/src-tauri/target/release/bundle/`.

---

## 🚀 Quick start (TL;DR)

1. **Add an API key.** Open *Providers* → *Add provider* → paste your key. It is saved into macOS Keychain / Windows Credential Manager / Linux Secret Service, never into the SQLite file.
2. **Create a project.** *Projects* → *New*. Optional: pick a template to auto-assign models to roles.
3. **Chat.** Pick a model on the chat page, type a message. Use `@another-model` to bring a second voice into the same conversation; tap **D** to trigger the multi-model debate loop.
4. **Bind a working folder.** Attach a directory on the right panel; Cosmgrid-Agent will use it for tools (read / grep / edit / bash) and show the diff inline.

For step-by-step walkthrough, see the user-facing guide ([project docs index](./项目文档/00-项目文档索引.md) — local-only, internal).

---

## 🔧 Configuration

- **API key storage:** `keystore.ts` wraps a Rust `keyring` command. macOS = Keychain, Windows = Credential Manager, Linux = Secret Service. Migration from the legacy `cosmgrid-keys.json` plaintext file is automatic (and deletes the legacy entry after migration).
- **Workspace root:** Tauri opens a per-user config directory under the OS convention; SQLite lives under there too.
- **Model registry:** Providers page is the source of truth for which models your build can reach.

Minimal config example:

```jsonc
// ~/.cosmgrid-agent/config.json (advanced; usually unnecessary)
{
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "fallbackChain": ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
  "theme": "system"
}
```

---

## 🛡️ Safety by default

Your conversations and tools run on your machine. Defaults:

- **Read tools** (read / glob / grep / git-read) — **run without confirmation**.
- **Write tools** (write / edit / bash) — **require an explicit per-tool confirmation** in the chat UI; reversibility comes from git inside the bound workspace.
- **Bash** — operates inside the bound workspace; commands outside it need a second confirmation.
- **Subscription CLI agents** (Claude Code / Codex shells) — spawned via `spawn_cli_stream`, **abort immediately kills the process group** via `kill_cli` SIGKILL — no zombie children.
- **Local-only** — no analytics, no telemetry, no remote calls beyond the model provider you configured.

---

## 🛠️ Tech stack

| Layer | Choice |
| --- | --- |
| Desktop shell | **Tauri 2** (not Electron; ~4.8 MB macOS dmg verified) |
| Frontend | **React 19** + **TypeScript 5.8** + **Vite 7** |
| UI | **shadcn/ui** (radix-ui) + **Tailwind v4** |
| Database | **SQLite 3** via `@tauri-apps/plugin-sql` (Rust sqlx underneath; frontend is pure TS, no Rust business logic) |
| API key store | System credential vault (macOS Keychain / Windows Credential Manager / Linux Secret Service) via Rust `keyring` |
| LLM adapter | **Vercel AI SDK 6** (`ai` + `@ai-sdk/{anthropic,openai,google}`) |
| Tool execution | Local **read / glob / grep / git-read** + guarded **write / edit / bash**; Rust `spawn_cli_stream` to consume Claude / Codex subscriptions |
| Tests | **Vitest** + v8 coverage (gate: `lines/functions/statements 80%`, `branches 75%`) |
| Package manager | **pnpm 11** |

> ⚠️ **No Prisma, no embedded Node server.** Either will break Tauri packaging because end users don't have a Node runtime on their box. The v0.3 architecture rework was specifically about avoiding this.

---

## 📁 Project layout

```
Cosmgrid-Agent/
├── README.md                  ← you are here (project overview, EN)
├── README.zh-CN.md            ← 中文版本
├── AGENTS.md                  ← project-level AI assistant instructions (Claude Code / Codex shared)
├── app/                       ← main code (Tauri + React)
│   ├── README.md              ← developer doc (architecture / modules / scripts)
│   ├── src/                   ← React frontend
│   │   └── pages/chat/        ← chat page (7 single-responsibility hooks)
│   ├── src-tauri/             ← Tauri shell (Rust: plugin config + spawn_cli_stream)
│   └── package.json
├── docs/                      ← public docs (verification logs, etc.)
├── 项目图标/                   ← logo source SVGs (5 candidates, naming pending)
└── 项目文档/                   ← internal process docs (gitignored, not pushed)
```

Developer-side detail (module boundaries, the 12 domain files `lib/db/` was split into, the `lib/llm/` adapter structure) lives in [`app/README.md`](./app/README.md).

---

## 🧑‍💻 Contributing

- **Issues / PRs:** welcome. Please skim [`AGENTS.md`](./AGENTS.md) for project-level conventions before opening a PR.
- **Reproducible bug reports:** include the exact path, relevant logs under `app/coverage/` and `app/test-artifacts/`, and your `Cosmgrid-Agent/version`. "It doesn't work" alone is hard to act on.
- **Branding / logo:** the 5 candidates in `项目图标/` need a single canonical pick + rename to match the new `Cosmgrid-Agent` name (see [Project status](#project-status)).

### Operator quick refs

```bash
# Type-check + frontend build
cd app && pnpm build

# Unit tests + coverage (80% gate)
pnpm test
pnpm test:coverage

# Desktop installer (the real end-to-end check)
pnpm tauri build

# Drop into the bundled app's SQLite for debugging
sqlite3 ~/Library/Application\ Support/cosmgrid-agent/cosmgrid.db
```

---

## 🌐 i18n

This repository keeps translations next to the main README:

- **English** — [`README.md`](./README.md) (default)
- **简体中文** — [`README.zh-CN.md`](./README.zh-CN.md)

Want to add a translation? Open a PR that mirrors the section structure of these two files.

---

## 📜 License

[MIT](./LICENSE) — see `LICENSE` (added with first tagged release).

---

## ⚠️ Project status

- Early version. No stable release tag yet. The full feature set is documented internally but is not committed to this repo; **the code + this README are the source of truth**.
- The `项目图标/` directory contains 5 SVG candidates still named after the older `Cosmgrid-Ai` prefix; once a canonical logo is chosen, the directory will be renamed and SVGs rebadged to match the new `Cosmgrid-Agent` name.
- Internal process docs (`项目文档/`) are gitignored and not pushed. Public-facing architecture is in `app/README.md` and this README.
- macOS is the author's daily driver; Windows / Linux have been routed through but lack systematic community regression coverage — please open issues with platform + version detail when you hit something on those OSes.

---

<sub>Want a working conversation in 60 seconds? Skip ahead to [Quick start](#quick-start-tldr).</sub>
