# ChatPage.tsx 拆分方案（v1）

> 日期：2026-07-01
> 状态：方案待红蓝对抗评审
> 目标：把 3104 行 / 32 个 useState/ref / 951 行 handleSend 的 ChatPage.tsx 拆成可维护的模块化结构，**不改变任何用户可见行为**。

## 一、现状实测（拆分前的硬数据）

### 1.1 规模

| 指标 | 实测值 |
|---|---|
| 总行数 | **3104** |
| useState | **32 个** |
| useRef | **15 个** |
| useEffect | **13 个** |
| 顶层/组件内函数 | **30+ 个** |
| `handleSend` 单个函数 | **951 行**（1076→2026）|
| JSX 渲染区 | 约 2606→3104，约 500 行 |

### 1.2 imports 数量

**84 行 import**（第 1-84 行），引用了 40+ 个模块。这是第一个信号：单个文件承担了太多职责。

### 1.3 已识别的职责（5 大块高度内聚）

通过分析 state、函数、effect 的耦合关系，ChatPage 实际混合了 **5 大职责**：

| # | 职责 | 核心 state | 核心函数 | 行数估算 |
|---|---|---|---|---|
| **A** | 对话列表 / 会话切换 / 重命名 / 删除 | `conversationId` `conversationList` | `handleNewChat` `switchConversation` `handleDeleteConversation` `handleRenameConversation` + `ConversationSwitcher` 子组件（已独立在 line 456） | ~250 |
| **B** | 模型 & 凭据加载 / 模型选择 / 智能挑选 | `availableModels` `credentials` `selectedModelId` | `loadModelsAndCreds` `handleSmartPick` | ~200 |
| **C** | **消息发送 / 流式 / 回退 / 落库**（最重） | `messages` `isStreaming` `streamElapsedMs` `pendingQueue` `streamError` `switchNotice` `cacheNotice` `harnessNotice` `lastUsage` + `abortRef` 等 | `handleSend`(951行) `persistAssistant` `runBackgroundOrchestration` | **~1100** |
| **D** | 多 AI 编排链 / 对弈 / 工作流快照 | `orchestration` `chainExecutedRoles` `chainSkippedRoles` `chainAbortedRole` `chainRunning` `workflowSnapshot` + 2 个 ref | `runChainIfNeeded` `buildDebateParticipants` | ~350 |
| **E** | 工作面板（IDE / artifacts / 工具调用视图 / 确认弹窗）| `panelOpen` `workspacePath` `artifacts` `toolCallViews` `pendingConfirm` + `confirmResolverRef` | `bindWorkspace` `chooseWorkspace` `clearWorkspace` `addFiles` `handleDroppedPaths` | ~400 |
| **F** | 附件 / 输入框 / 滚动 | `draftAttachments` `inputAreaH` `showJumpToBottom` + 多个 ref | `handlePaste` `handleDroppedPaths` `scrollToBottom` | ~200 |

> 注：A-F 职责内部高度内聚，职责之间通过明确的 state 交互。**这是拆分能成立的关键证据**——不是"硬拆"，而是"按已存在的内聚边界分离"。

---

## 二、拆分策略

### 2.1 核心原则（不可妥协）

1. **纯重构，零行为变更**：用户看到的、点到的、流式出来的内容完全不变。任何"顺手优化"全部拒绝。
2. **渐进式、每步可验证**：不一次性大爆炸拆分。每个阶段拆完立即 `pnpm tsc && pnpm test`，绿了才进下一步。
3. **自定义 hook 是主力工具**：React 的 hook 天然适合"把 state + 相关逻辑打包搬走"。不引入 Redux/Zustand 等新依赖（项目 AGENTS.md 技术栈里没有，不擅自加）。
4. **纯函数优先抽出**：已经无 state 依赖的函数（`filterReadRecordsSince` `parseReceipt` `dbMessagesToChat` `formatElapsed`）最先搬到 utils 文件，零风险。
5. **类型集中管理**：`ChatMessage` `HarnessWarning` `ReceiptContent` 等共享类型抽到独立的 `types.ts`，避免循环依赖。
6. **不改测试**：现有 951 个测试是护栏。拆分后测试必须**全绿且数量不变**。如果某测试因 import 路径变了挂掉，只改测试的 import，不改断言。

### 2.2 不做的事（边界）

- ❌ 不引入状态管理库（Zustand/Redux）—— 超出"拆分"范围，是新架构决策
- ❌ 不改任何业务逻辑（回退策略、对弈触发、工具确认流程等）
- ❌ 不改 i18n key、不改 className、不改 UI 布局
- ❌ 不重命名导出的公开 API（`ConversationSwitcher` 等已暴露的组件名保持不变）
- ❌ 不删任何"看起来没用"的代码 —— 先忠于现状，死代码清理是另一回事
- ❌ 不改 db.ts / chat-fallback.ts 等被引用模块 —— 只动 ChatPage.tsx 自己

### 2.3 目标目录结构

```
app/src/pages/
├── ChatPage.tsx                    # 重构后：仅做组合 + 顶层布局，目标 < 600 行
├── chat/                           # 新建目录
│   ├── types.ts                    # ChatMessage / HarnessWarning / ReceiptContent 等共享类型
│   ├── chat-utils.ts               # 纯函数：filterReadRecordsSince / parseReceipt / dbMessagesToChat / formatElapsed
│   ├── useConversations.ts         # hook A：会话列表 CRUD + 切换
│   ├── useModelSelection.ts        # hook B：模型/凭据加载 + 选择 + 智能挑选
│   ├── useChatStream.ts            # hook C：消息发送 / 流式 / 回退 / 落库（最重，可能再拆）
│   ├── useOrchestration.ts         # hook D：编排链 / 对弈 / 工作流快照
│   ├── useWorkPanel.ts             # hook E：工作面板状态 + 工具确认 + workspace 绑定
│   ├── useChatInput.ts             # hook F：附件 / 输入框 / 滚动 / 拖拽
│   └── components/                 # 已从 ChatPage 抽出的子组件（CollapsibleBlock 等）
│       ├── CollapsibleBlock.tsx
│       ├── MessageList.tsx         # 消息流渲染（从 JSX 拆出）
│       ├── ChatInput.tsx           # 输入区（从 JSX 拆出）
│       ├── WorkPanel.tsx           # 右侧工作面板容器（从 JSX 拆出）
│       └── ConversationSwitcher.tsx # 已存在，搬过来
```

---

## 三、分阶段实施计划（7 阶段，每阶段独立可验证）

> 每阶段结束的验收闸门：`pnpm tsc` 0 错 + `pnpm test` 951 全过 + `pnpm build` 通过。任一红则回滚该阶段。

### 阶段 0：安全准备（30 分钟）

**动作**：
1. 确认当前 git 工作区干净（已确认：当前分支 `feat/main-chat-multi-conversation`，clean）
2. 创建拆分专用分支：`git checkout -b refactor/chat-page-split`
3. 跑一次基线：`pnpm tsc && pnpm test`，记录"951 passed"作为对照基线
4. 给 ChatPage.tsx 当前版本打 tag：`git tag chatpage-pre-refactor`

**为什么**：任何阶段出问题都能 `git reset --hard chatpage-pre-refactor` 回到已知良好状态。

### 阶段 1：抽类型 + 纯函数（零风险，1 小时）

**搬动内容**（全是已无 state 依赖的代码）：
- `interface ChatMessage`（line 86-117）→ `chat/types.ts`
- `interface HarnessWarning`（line 119-125）→ `chat/types.ts`
- `interface ReceiptContent`（line 127-131）→ `chat/types.ts`
- `type ChatUsage`（line 133）→ `chat/types.ts`
- `function filterReadRecordsSince`（line 135-140）→ `chat/chat-utils.ts`
- `function parseReceipt`（line 143-154）→ `chat/chat-utils.ts`
- `function dbMessagesToChat`（line 158-183）→ `chat/chat-utils.ts`
- `function formatElapsed`（line 186-190）→ `chat/chat-utils.ts`

**ChatPage.tsx 改动**：删掉这些定义，改成 `import { ChatMessage, ... } from "./chat/types"` 和 `import { dbMessagesToChat, ... } from "./chat/chat-utils"`。

**风险**：极低。纯搬运 + import 路径变更。tsc 会立即报出任何遗漏。

**验证**：tsc + test。

### 阶段 2：抽子组件（低风险，1-2 小时）

**搬动内容**（已是 `memo` 包裹的独立组件）：
- `CollapsibleBlock`（line 198-?，memo 组件）→ `chat/components/CollapsibleBlock.tsx`
- `ConversationSwitcher`（line 456-?，已是独立 function 组件）→ `chat/components/ConversationSwitcher.tsx`

这两个已经是组件，只是物理位置在 ChatPage.tsx 里。搬出来需要把它们用到的辅助函数/类型一并 import。

**风险**：低。它们已经是独立单元，只是搬位置 + 处理依赖。

**验证**：tsc + test + 手动启动 dev 看对话页能正常渲染。

### 阶段 3：抽 hook A（会话管理，中等风险，2-3 小时）

**新建 `useConversations.ts`**，搬入：
- state：`conversationId` `conversationList`
- ref：`conversationIdRef`
- 函数：`handleNewChat` `switchConversation` `handleDeleteConversation` `handleRenameConversation`
- 相关 effect

**接口设计**：
```ts
export function useConversations(deps: {
  setMessages: (m: ChatMessage[]) => void;  // 切会话时清空/加载消息
  // 其他需要回调父组件的动作
}) {
  // ...
  return {
    conversationId, conversationList,
    handleNewChat, switchConversation, handleDeleteConversation, handleRenameConversation,
    setConversationId,
  };
}
```

**难点**：`switchConversation` 切换会话时要联动清空 messages、artifacts、orchestration 等多个其他职责的 state。这是跨 hook 通信的核心问题。

**解决**：hook 接收一个 `onSwitchConversation(id: string)` 回调，由 ChatPage 协调其他 hook 的清理。**不在 hook 内部直接改其他 hook 的 state**。

**验证**：tsc + test + 手动测试新建/切换/删除/重命名会话。

### 阶段 4：抽 hook B（模型选择，低-中风险，1-2 小时）

**新建 `useModelSelection.ts`**，搬入：
- state：`availableModels` `credentials` `selectedModelId`
- 函数：`loadModelsAndCreds` `handleSmartPick`
- 相关 effect（模型列表加载）

**接口设计**：
```ts
export function useModelSelection() {
  return { availableModels, credentials, selectedModelId, setSelectedModelId, handleSmartPick, reloadModels };
}
```

**难点**：`handleSmartPick` 调用了 `buildRolePerformanceScoresFromUsageRows` `pickBestModelForRole` 等外部函数，依赖 `usageEvents` 数据。这些依赖通过参数或闭包传入。

**验证**：tsc + test + 手动切换模型、点智能挑选。

### 阶段 5：抽 hook F（输入/附件/滚动，低风险，1-2 小时）

**新建 `useChatInput.ts`**，搬入：
- state：`draftAttachments` `inputAreaH` `showJumpToBottom`
- ref：`scrollRef` `inputRef` `inputAreaRef` `stickToBottomRef`
- 函数：`handlePaste` `addFiles` `scrollToBottom`
- 相关 effect（滚动监听、拖拽监听）

**为什么先做 F 不做 C**：F 职责清晰、与最重的 C（消息发送）耦合最低，先做个简单 hook 练手，建立 hook 抽取的范式。

**验证**：tsc + test + 手动粘贴/拖拽文件、滚动测试。

### 阶段 6：抽 hook E（工作面板，中等风险，2-3 小时）

**新建 `useWorkPanel.ts`**，搬入：
- state：`panelOpen` `workspacePath` `artifacts` `toolCallViews` `pendingConfirm`
- ref：`confirmResolverRef`
- 函数：`bindWorkspace` `chooseWorkspace` `clearWorkspace`

**难点**：
- `pendingConfirm` + `confirmResolverRef` 是工具执行的确认弹窗机制，需要 Promise 化的确认流程
- `artifacts` / `toolCallViews` 是从 `messages` + `toolExecutions` 派生的工作面板内容，与 hook C/D 都有数据流关系

**接口设计**：
```ts
export function useWorkPanel(deps: {
  messages: ChatMessage[];
  conversationId: string | null;
}) {
  return {
    panelOpen, setPanelOpen, workspacePath, artifacts, toolCallViews,
    pendingConfirm, setPendingConfirm,
    bindWorkspace, chooseWorkspace, clearWorkspace,
    confirmResolverRef,
  };
}
```

**验证**：tsc + test + 手动选工作文件夹、触发工具执行看确认弹窗、看 artifacts 渲染。

### 阶段 7：抽 hook D（编排/对弈，高风险，3-4 小时）

**新建 `useOrchestration.ts`**，搬入：
- state：`orchestration` `chainExecutedRoles` `chainSkippedRoles` `chainAbortedRole` `chainRunning` `workflowSnapshot`
- ref：`orchestrationRef` `workflowSnapshotRef` `chainAbortRef`
- 函数：`runChainIfNeeded` `buildDebateParticipants` + 相关的对弈触发逻辑

**为什么高风险**：
- 编排状态与消息发送（C）紧耦合：chain 接力时要往 messages 里追加角色消息、更新 chainStep/chainDone
- `runChainIfNeeded` 调用了 `runChainImpl` `realRunRole` `archiveDynamicDebateResult` 等多个副作用函数
- 对弈触发逻辑分散在 `handleSend` 内部，需要先理清边界才能拆

**策略**：先把 state + 简单 setter 搬走，编排/对弈的**触发逻辑暂时留在 ChatPage**（作为协调层），等 hook C 拆完后再把触发逻辑也搬进 hook D。

**验证**：tsc + test + 手动触发一次完整对弈（复杂问题→自动建议→对弈跑完→结果落库）。

### 阶段 8：抽 hook C（消息发送/流式，最高风险，4-6 小时）

**新建 `useChatStream.ts`**，搬入核心：
- state：`messages` `isStreaming` `streamElapsedMs` `pendingQueue` `streamError` `switchNotice` `cacheNotice` `harnessNotice` `lastUsage`
- ref：`drainingRef` `abortRef` `pendingRoutingDecisionRef`
- 函数：`handleSend`（951 行巨兽）`persistAssistant` `runBackgroundOrchestration` + 相关 effect

**这是整个拆分的难点**，因为：
1. `handleSend` 951 行内部混合了：消息构建、附件处理、语义缓存、路由决策、流式调用、回退、落库、用量统计、Harness 校验、对弈触发、编排触发。**它本身就需要再拆**。
2. 它依赖几乎所有其他 hook 的 state 和函数。

**策略——先把 handleSend 内部拆成子函数**：

```
handleSend(text, attachments)
  ├── buildOutgoingMessage(text, attachments)     // 构建用户消息 + 落库
  ├── trySemanticCache(query)                     // 语义缓存命中？
  ├── decideRouting(query, history)               // 路由决策（智能/手动）
  ├── executeStream(endpoint, messages, signal)   // 真正调 streamWithFallback
  ├── handleStreamCallbacks()                     // 流式 onChunk/onDone/onError
  ├── runPostStreamChecks(result)                 // Harness 校验 + 对弈建议
  └── persistAndNotify()                          // 落库 + 用量统计 + notice
```

每个子函数 50-150 行，可读性大幅提升。然后再把这些子函数连同 state 一起搬进 `useChatStream`。

**hook C 的接口**（最复杂的协调点）：
```ts
export function useChatStream(deps: {
  conversationId: string | null;
  selectedEndpoint: ModelEndpoint | null;
  workspacePath: string | null;
  availableModels: ModelListItem[];
  // 编排/对弈的触发回调（hook C 调用，hook D 实现）
  onChainTrigger: (args: ChainTriggerArgs) => Promise<void>;
  onDebateSuggested: (args: DebateSuggestion) => void;
  // 工作面板更新
  onArtifactsDerived: (msgs: ChatMessage[]) => void;
}) {
  return {
    messages, setMessages, isStreaming, streamError, lastUsage,
    switchNotice, cacheNotice, harnessNotice,
    handleSend, handleAbort,
  };
}
```

**验证**：
- tsc + test（必须 951 全过）
- **重点手动测试**：普通对话、流式中断（abort）、限额触发回退、语义缓存命中、附件对话、对弈自动建议触发、编排链触发。每一种场景都要实跑一遍。

### 阶段 9：收尾（1 小时）

1. ChatPage.tsx 最终应只剩：hook 组合 + 顶层 `<div>` 布局 + 把 props 传给子组件。目标 **< 600 行**。
2. 删除拆分过程中产生的临时注释、调试代码
3. 跑完整验证三件套：`pnpm tsc && pnpm test && pnpm build`
4. 更新 `ChatPage.tsx` 顶部注释（如果有的话）
5. Commit + 在 commit message 里记录拆分前后的行数对比

---

## 四、跨 hook 通信的关键设计

### 4.1 状态归属表（避免重复 state）

| 状态 | 归属 hook | 谁读 | 谁写 |
|---|---|---|---|
| `conversationId` | A 会话 | 所有 hook（通过参数传入） | A |
| `messages` | C 流式 | C 主用；E 派生 artifacts 时读 | C 主写；A 切会话时清空（通过回调） |
| `selectedModelId` | B 模型 | C（决定用哪个端点） | B |
| `workspacePath` | E 面板 | C（工具执行用）、D（编排上下文） | E |
| `orchestration` | D 编排 | C（handleSend 里读）、渲染层 | D |
| `pendingConfirm` | E 面板 | 渲染层（弹窗） | C（工具请求时 set） |
| `isStreaming` | C 流式 | 渲染层、A（切会话时要 abort） | C |

### 4.2 通信模式（3 种，按优先级）

1. **父组件单向传 props 给 hook**（默认）：ChatPage 把 state 值作为参数传给 hook。最简单，单向数据流清晰。
2. **回调注入**（hook 需要改别人的 state）：hook 接收 `onXxx` 回调，由 ChatPage 实现并转发给对应 hook。例：hook C 要清空 messages 时调 `onClearMessages()`，ChatPage 转发给 hook C 自己的 `setMessages([])`。
3. **谨慎使用 ref 共享**（性能敏感的实时值）：如 `orchestrationRef` 需要在 `handleSend` 闭包里读到最新值，避免 stale closure。这种只在确有性能/闭包问题时用，且必须注释清楚为什么不能用 state。

### 4.3 坚决不做的通信

- ❌ 不用 React Context（项目没用，且 Context 重渲染是性能坑）
- ❌ 不用 event bus / 自定义发布订阅（调试地狱）
- ❌ 不把多个 hook 的 state 合并成一个大 state 对象（回到 God state）

---

## 五、风险清单与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| **R1：拆分引入 stale closure**（闭包捕获了旧 state 值）| 高 | 高（流式中断、abort 失效） | 保留所有 `useRef` 的原设计；关键值用 ref 镜像；每个阶段的手动测试重点验 abort/中断 |
| **R2：拆分后 useEffect 依赖数组漏项** | 中 | 高（无限渲染、effect 不触发） | 严格保留原依赖数组；tsc + 仔细 review 每个搬动的 effect；用 `eslint-plugin-react-hooks` 兜底 |
| **R3：hook 间循环依赖** | 中 | 中（tsc 报错） | 类型集中在 `types.ts`，hook 之间不互相 import，只通过 ChatPage 中转 |
| **R4：测试因 import 路径变化挂掉** | 低 | 低 | 只改测试的 import 路径，不改断言；如某测试因内部实现变化挂掉，说明拆分改了行为，必须回滚 |
| **R5：阶段 8（hook C）拆 handleSend 时改了行为** | 高 | 高 | handleSend 内部拆子函数时，**先原样搬、不改逻辑**，子函数拆完跑一次测试确认行为不变，再搬进 hook |
| **R6：性能回归**（拆分后组件重渲染范围变化）| 低 | 中 | 用 React.memo 包裹重型子组件（MessageList 等）；拆分后用 React DevTools profiler 对比关键路径渲染时间 |
| **R7：手动测试覆盖不足，拆坏了没发现** | 中 | 高 | 见下方"测试策略" |

---

## 六、测试策略

### 6.1 自动化测试（护栏，不可妥协）

每个阶段结束必须：
```bash
pnpm tsc --noEmit     # 0 错
pnpm test             # 951 passed（与基线完全一致）
pnpm build            # 通过
```

**红线**：测试数量下降 = 拆分改了行为 = 立即回滚。

### 6.2 手动测试清单（每个高风险阶段后执行）

阶段 7（hook D）后：
- [ ] 新建对话发普通消息 → 正常回复
- [ ] 发复杂问题 → 触发对弈建议
- [ ] 触发一次完整对弈 → 三个角色跑完 → 结果落库

阶段 8（hook C）后（**最关键**）：
- [ ] 普通文本对话
- [ ] 流式中点击停止（abort）→ 真的停了
- [ ] 模型限额场景 → 触发回退 → switchNotice 显示
- [ ] 重复问题 → 语义缓存命中 → cacheNotice 显示
- [ ] 拖入文件 → 附件正常处理
- [ ] 模型回答引用了文件但没真调 read → harness 警告显示
- [ ] 发送时点新建对话 → 旧流被 abort

阶段 9（收尾）后：
- [ ] 浅色/深色模式各过一遍
- [ ] 工作面板展开/收起、IDE 内容渲染
- [ ] 工具执行确认弹窗（确认/取消）

### 6.3 不写新测试

**这是纯重构，不增加测试**。原因：
1. 现有 951 个测试已覆盖逻辑
2. 新加测试会掩盖"拆分是否保持行为"这个核心问题
3. 如果拆分正确，现有测试应该原样通过

例外：如果拆分过程中发现某段逻辑**原本就没有测试覆盖**（如某些 effect），记录下来但不在本次拆分中补——避免混入"改进"导致行为变更难以察觉。

---

## 七、成功标准

拆分完成后的验收：

| 标准 | 目标 | 验证方式 |
|---|---|---|
| ChatPage.tsx 行数 | **< 600 行**（从 3104 降） | `wc -l` |
| 单个文件最大行数 | 无文件 > 800 行 | `find \| xargs wc -l \| sort` |
| 单个函数最大行数 | 无函数 > 200 行（handleSend 拆成子函数后） | 人工 + lint |
| TypeScript | 0 错误 | `pnpm tsc` |
| 测试 | 951 passed（与基线一致）| `pnpm test` |
| 构建 | 通过 | `pnpm build` |
| 行为 | 用户可见行为零变化 | 手动测试清单全过 |
| imports 整洁度 | ChatPage.tsx 的 import 行数 < 30 | 人工 |

---

## 八、工时估算

| 阶段 | 估时 | 风险 |
|---|----|---|
| 0 准备 | 0.5h | - |
| 1 类型+纯函数 | 1h | 极低 |
| 2 子组件 | 1.5h | 低 |
| 3 hook A 会话 | 2.5h | 中 |
| 4 hook B 模型 | 1.5h | 低-中 |
| 5 hook F 输入 | 1.5h | 低 |
| 6 hook E 面板 | 2.5h | 中 |
| 7 hook D 编排 | 3.5h | 高 |
| 8 hook C 流式 | 5h | 最高 |
| 9 收尾 | 1h | - |
| **合计** | **~20h（约 3 个工作日）** | |

**建议分多次会话完成，不要一次硬推**。阶段 7-8 是高风险，建议每次只推 1-2 个阶段，充分手动测试后再继续。

---

## 九、回滚预案

任何阶段如果 tsc/test/build 三件套任一红，且 30 分钟内无法修复：

```bash
git reset --hard chatpage-pre-refactor
```

回到阶段 0 的已知良好状态，重新评估该阶段的拆分边界。

每个阶段独立 commit，commit message 格式：`refactor(chat): 阶段N - 抽出 xxx`。这样即使后期某阶段暴露问题，也能 `git revert` 单个阶段。

---

## 十、待红蓝对抗确认的开放问题

以下问题我有倾向但想听红蓝双方意见：

1. **hook C 的 `handleSend` 是否要在本次拆分中再拆子函数？**
   - 倾向：要拆（否则只是把 951 行从一个文件搬到另一个文件，没解决根本问题）
   - 但风险更高，是否应该作为"拆分之后的下一步"单独做？

2. **ConversationSwitcher 已是独立组件（line 456），是否单独先搬？**
   - 倾向：是，它最独立，可以作为阶段 2 的第一个练手

3. **是否需要引入 `useReducer` 管理某些强相关的 state 簇？**
   - 如编排相关的 6 个 state（orchestration + chainExecutedRoles + chainSkippedRoles + chainAbortedRole + chainRunning + workflowSnapshot）天然是一个 reducer 的 candidate
   - 但引入 useReducer 算"改架构"，超出纯拆分范围

4. **hook 之间的依赖注入用对象参数还是位置参数？**
   - 倾向：对象参数（`deps: { conversationId, selectedModelId, ... }`），易扩展
   - 但可能过度工程化

5. **阶段顺序是否合理？先 F 后 C 的策略是否最优？**
   - 倾向：按风险从低到高排（1→2→5→4→3→6→7→8），先建立范式再啃硬骨头
