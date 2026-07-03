# ChatPage.tsx 拆分方案（v2 · 红蓝对抗定稿）

> 日期：2026-07-03
> 状态：方案已通过红蓝对抗评审并定稿
> 前序：v1 方案数据已过期（基于 3104 行旧版），本版基于当前真实代码（1938 行）重写

---

## 一、当前真实进度（2026-07-03 实测）

### 1.1 已完成（外围清理，质量不错）

| 类别 | 数量 | 文件 |
|---|---|---|
| 纯逻辑模块 | 14 个 | `chat-format` / `chain-messages` / `debate-participants` / `debate-result` / `history` / `model-chain` / `optimistic-turn` / `orchestration-receipt` / `prompt-compression` / `prompt-messages` / `stream-retry` / `streaming-callbacks` / `streaming-status` / `types` |
| 子组件 | 8 个 | `ChatHeader` / `ChatInputDock` / `ChatMessageItem` / `ChatTranscript` / `ChatWorkPanel` / `ConversationSwitcher` / `QueuedMessageItem` / `ToolConfirmCard` |
| 自定义 hook | 1 个 | `useChatAttachments` |
| 配套测试 | 9 个 | 覆盖纯函数逻辑 |

**红队定性**："50% 进度是进度幻觉。已抽的多是叶子纯函数，真正的大内核（handleSend / debate / 编排）原封未动。"

### 1.2 未完成（本次方案的目标）

ChatPage.tsx 仍是 **1938 行**，内部还压着：

| 指标 | 实测 |
|---|---|
| useState | **31 个** |
| useRef | **14 个** |
| useEffect | **10 个** |
| `handleSend` 单函数 | **823 行**（570→1393）|
| 核心大函数全在主文件 | `handleNewChat` / `switchConversation` / `handleSend` / `runBackgroundOrchestration` / `runChainIfNeeded` |
| debate 引用 | 38 处 |
| 编排引用 | 43 处 |

**所谓 commit "大文件拆分100%" 名不副实**：实际是"外围 100%，内核 0%"。

---

## 二、6 大职责的真实边界（实测验证）

### 2.1 state 归属表（已重新核对行号）

| # | 职责 | state（行号） | 共享 ref |
|---|---|---|---|
| **A** | 会话管理 | `conversationId`(110) `conversationList`(111) | `conversationIdRef`(183) |
| **B** | 模型选择 | `availableModels`(107) `credentials`(108) `selectedModelId`(109) | — |
| **C** | 消息流/流式 | `messages`(112) `isStreaming`(113) `streamElapsedMs`(114) `pendingQueue`(116) `streamError`(118) `switchNotice`(119) `cacheNotice`(120) `harnessNotice`(122) `lastUsage`(123) | `abortRef`(189) `drainingRef`(117) `pendingRoutingDecisionRef`(191) `handleSendRef`(1395) |
| **D** | 编排/对弈 | `orchestration`(144) `chainExecutedRoles`(148) `chainSkippedRoles`(149) `chainAbortedRole`(150) `chainRunning`(151) `workflowSnapshot`(153) | `orchestrationRef`(138) `workflowSnapshotRef`(147) `chainAbortRef`(190) |
| **E** | 工作面板 | `panelOpen`(126) `workspacePath`(130) `protectedWorkspaces`(136) `artifacts`(138) `toolCallViews`(139) `pendingConfirm`(141) | `confirmResolverRef`(135) |
| **F** | 输入/滚动 | `inputAreaH`(203) `showJumpToBottom`(218) | `scrollRef`(191) `inputRef`(192) `inputAreaRef`(195) `stickToBottomRef`(210) |
| — | 错误页 | `loadError`(124) | — |

### 2.2 红队实测：会话切换是跨职责协调器（关键约束）

`switchConversation` **一个函数写了 12 个跨职责 setter**：
```
applyOrchestration(D)  applyToolExecutionRows(?)  setArtifacts(E)
setCacheNotice(C)      setConversationId(A)        setMessages(C)
setPendingQueue(C)     setSelectedModelId(B)       setStreamError(C)
setSwitchNotice(C)     setToolCallViews(E)          setWorkspacePath(E)
```

`handleNewChat` 写了 11 个，`handleStop` 写了 3 个。

**结论（红蓝共识）**：会话切换不能搬进 hook A，否则要么 hook A 成空壳，要么把这一坨 setter 全摊回 ChatPage 协调。**会话切换必须留在 ChatPage 作为协调层**，hook A 只负责会话列表的 CRUD + state 持有。

---

## 三、定稿策略（融合红蓝意见）

### 3.1 核心原则（不可妥协）

1. **纯重构，零行为变更**——任何"顺手优化"全部拒绝
2. **每阶段独立 commit + 独立验证**——`pnpm tsc && pnpm test && pnpm build` 三件套任一红则回滚该阶段
3. **基线已更新**：当前是 **1101 测试全过**（90 文件）。这是新的回归基线，测试数下降即报警
4. **不引入新依赖**——不上 Redux/Zustand/Context，沿用 props + 回调 + ref 三件套（红蓝共识）
5. **D 职责用 useReducer**——蓝队建议，6 个编排 state 是天然状态机
6. **handleSend 内部拆子函数独立成阶段**——红蓝共识，不和 hook 化混在一起

### 3.2 不做的事（边界）

- ❌ 不改业务逻辑（路由、回退、对弈、工具确认）
- ❌ 不改 i18n key / className / UI 布局
- ❌ 不删"看起来没用"的代码（死代码清理是另一回事）
- ❌ 不改被引用的模块（db.ts / chat-fallback.ts 等）
- ❌ 不引入 Context / event bus / 发布订阅

### 3.3 跨 hook 通信模式（沿用项目既有范式）

1. **父组件单向传 props**（默认）：ChatPage 把 state 值作参数传 hook
2. **回调注入**（hook 要改别人的 state）：hook 收 `onXxx` 回调，ChatPage 转发
3. **ref 共享**（闭包要读最新值）：如 `conversationIdRef` / `handleSendRef`，对齐项目既有范式

---

## 四、定稿执行顺序（红蓝共识：风险递增 + 会话最后做）

> 每阶段结束的验收闸门：`pnpm tsc` 0 错 + `pnpm test` 1101 全过 + `pnpm build` 通过。

### 阶段 0：准备（已完成 ✅）

- [x] 工作区已干净
- [x] 已建分支 `feat/main-chat-multi-conversation`
- [x] 队列 stale closure 地雷已修（commit `0825320`）

### 阶段 1：合并 chat-format.ts（5 分钟，蓝队优化）

`chat-format.ts` 只有 6 行（`formatElapsed` 流式状态计时函数），轻度过度拆分。合并进 `streaming-status.ts`（主题最匹配——都是流式状态相关工具），更新对应 import。

> 实际落地（2026-07-03）：合并到 `streaming-status.ts`（不是 types.ts/history.ts）。理由：`formatElapsed` 是 UI 计时工具函数，types.ts 是纯类型定义不该混入工具；streaming-status.ts 18 行 → 25 行，仍小而聚焦。`ChatTranscript.tsx:8` / `ChatWorkPanel.tsx:11` 两处 import 已更新。

### 阶段 2：hook B 模型选择（~1.5h，最纯）

**新建 `useModelSelection.ts`**，搬入：
- state：`availableModels` `credentials` `selectedModelId`
- 函数：`loadModelsAndCreds` `handleSmartPick` `handleModelChange`
- 模型加载相关 effect

**为什么先做 B**：最纯，无跨 hook 写入，用来建立 hook 抽取范式。

**接口**：
```ts
export interface UseModelSelectionOptions {
  // 跨 hook 读（ref 镜像避免 stale closure）
  conversationId: string | null;
  messages: ChatMessage[];
  orchestrationRef: MutableRefObject<OrchestrationState | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  pendingRoutingDecisionRef: MutableRefObject<PendingRoutingDecision | null>;
  active: boolean;

  // 跨 hook 写（按范式回调注入，不直接调外部 setter）
  applyOrchestration: (next: OrchestrationState | null) => void;
  setSwitchNotice: (message: string | null) => void;
  onConversationDefaultModelChanged: (newModelId: string) => void;

  // 业务依赖
  alert: (opts: AlertOptions) => Promise<void>;
  t: TFunction;
}

export function useModelSelection(opts: UseModelSelectionOptions) {
  return {
    availableModels, credentials, selectedModelId,
    setSelectedModelId, handleSmartPick, handleModelChange, loadModelsAndCreds,
  };
}
```

**接口复杂度高于方案 v2**：实际跨 **5 个外部 state/ref + 3 个回调注入**，不是方案 v2 描述的"无跨 hook 写入"。原因：`handleModelChange` 改会话默认模型（跨 hook 写）、`handleSmartPick` 读 inputRef.current 和 pendingRoutingDecisionRef、handleSmartPick 触发时需改 orchestration 状态。**全部按既定范式（回调注入 + ref 镜像）处理**，未引入 Context/event bus。

**留 ChatPage 协调层的函数**：
- `pickConversationModelId`（helper，handleNewChat/switchConversation 仍调）
- `handleNodeModelChange`（归 hook D 协调，本阶段不搬；但用 hook B 返回的 `setSelectedModelId`）

**验证**：tsc 0 错 + test 1101 passed + build 8s。手动测试（未跑，待用户）：切换模型、智能挑选、新对话、切回聊天页刷新模型列表。

> **实际落地（2026-07-03）**：ChatPage.tsx 1944 → 1835 行（**-109 行**）；useModelSelection.ts 221 行。

### 阶段 3：hook F 输入/滚动（~1h，几乎白送）

**新建 `useChatInput.ts`**，搬入：
- state：`inputAreaH` `showJumpToBottom`
- ref：`scrollRef` `inputRef` `inputAreaRef` `stickToBottomRef`
- 函数：`scrollToBottom` + 滚动/拖拽监听 effect

**为什么这么快**：`useChatAttachments`（附件相关）已经抽完，F 只剩滚动和输入框高度。

**验证**：tsc + test + 手动滚动、粘贴、拖拽文件。

### 阶段 4：hook E 工作面板（~2.5h）

**新建 `useWorkPanel.ts`**，搬入：
- state：`panelOpen` `workspacePath` `protectedWorkspaces` `artifacts` `toolCallViews` `pendingConfirm`
- ref：`confirmResolverRef`
- 函数：`bindWorkspace` `chooseWorkspace` `clearWorkspace` `applyToolExecutionRows`

**关键**：`pendingConfirm + confirmResolverRef` 是 Promise 化的工具确认流，**整体搬走**，接口收敛为 `requestConfirm(req): Promise<boolean>`。

**验证**：tsc + test + 手动选工作文件夹、触发工具执行看确认弹窗、看 artifacts 渲染。

### 阶段 5：hook D 编排/对弈（~3h，用 useReducer）

**新建 `useOrchestration.ts`**，搬入 6 state + 配套逻辑，**用 useReducer 重构**：

```ts
// 蓝队建议：6 state 是天然状态机
type OrchState = { orchestration; chainExecutedRoles; chainSkippedRoles; chainAbortedRole; chainRunning; workflowSnapshot };
type OrchAction =
  | { type: "apply_orchestration"; state: OrchestrationState }
  | { type: "chain_start" }
  | { type: "chain_role_done"; role: RoleId }
  | { type: "chain_role_skipped"; role: RoleId }
  | { type: "chain_abort"; role: RoleId }
  | { type: "chain_end" }
  | { type: "apply_workflow"; snapshot: WorkflowSnapshot }
  | { type: "reset" };
```

**留在 ChatPage 的协调函数**（红队强调）：`runChainIfNeeded` 和对弈触发逻辑仍调 hook C/D 的接口，先不搬。这一步只把 **state 持有 + reducer** 搬走。

**验证**：tsc + test + 手动触发一次完整对弈（复杂问题→自动建议→三角色跑完→结果落库）。

### 阶段 6：handleSend 内部拆子函数（~2h，独立成阶段）

**红蓝共识**：handleSend 823 行必须在本次拆分中再拆，否则只是搬文件。

**先在 ChatPage 原地拆**（不搬进 hook），拆完跑测试确认行为不变，再进阶段 7：

```
handleSend(text, attachments)
  ├── prepareTurn(text, attachments)         // 构建用户消息 + 落库 + 乐观更新
  ├── maybeRunDebate(query)                  // 对弈触发判断（return early）
  ├── tryCacheHit(query)                     // 语义缓存命中？（return early）
  ├── runStreamLoop(endpoint, msgs, signal)  // 真正调 streamWithFallback + 流式回调
  └── postStreamOrchestration(result)        // Harness 校验 + 编排触发 + 用量统计
```

每段目标 < 150 行。**单独 commit**：`refactor(chat): handleSend 拆 5 段子函数`。

**验证**：tsc + test + 重点手动测试（普通对话、流式中断、限额回退、缓存命中、对弈建议、编排触发）。

### 阶段 7：hook C 流式（~5-6h，最高风险）

**新建 `useChatStream.ts`**，搬入：
- state：`messages` `isStreaming` `streamElapsedMs` `pendingQueue` `streamError` `switchNotice` `cacheNotice` `harnessNotice` `lastUsage`
- ref：`abortRef` `drainingRef` `pendingRoutingDecisionRef` `handleSendRef`（含阶段 6 拆好的子函数）
- 函数：阶段 6 拆好的 5 个子函数 + `handleStop` + `runBackgroundOrchestration`
- 队列排空 effect（用 `handleSendRef` 的那个）

**接口（最复杂）**：
```ts
export function useChatStream(deps: {
  conversationId: string | null;
  conversationIdRef: MutableRefObject<string | null>;
  selectedModelId: string;
  availableModels: ModelListItem[];
  workspacePath: string | null;
  orchestrationRef: MutableRefObject<OrchestrationState | null>;
  onArtifactsDerived: (msgs: ChatMessage[]) => void;
  onChainTrigger: (args: ChainTriggerArgs) => Promise<void>;
  onDebateSuggested: (s: DebateSuggestion) => void;
}) {
  return {
    messages, setMessages, isStreaming, streamError, lastUsage,
    switchNotice, cacheNotice, harnessNotice,
    handleSend, handleStop,
    abortRef,
  };
}
```

**验证**：
- tsc + test（必须 1101 全过）
- **重点手动测试**：普通对话 / 流式中断（abort）/ 限额回退 / 缓存命中 / 附件对话 / 对弈自动建议 / 编排链触发

### 阶段 8：hook A 会话（~2.5h，最后做）

**新建 `useConversations.ts`**，搬入：
- state：`conversationId` `conversationList`
- ref：`conversationIdRef`
- 函数：会话列表 CRUD（`loadConversations` `handleDeleteConversation` `handleRenameConversation`）

**留在 ChatPage 的协调层**（红队强约束）：
- `switchConversation` / `handleNewChat` / `handleStop` 仍是 ChatPage 的协调函数
- 它们调用各 hook 暴露的 reset 接口（`resetForSwitch(id)` 聚合清理）
- ChatPage 保留约 **150-200 行协调层**，这是合理的（不是 God component，是协调器）

**验证**：tsc + test + 手动新建/切换/删除/重命名会话。

### 阶段 9：收尾（~1h）

1. ChatPage.tsx 最终目标 **< 800 行**（含约 200 行协调层 + JSX 渲染组合）
2. 删临时注释
3. 跑完整三件套：`pnpm tsc && pnpm test && pnpm build`
4. 最终 commit

---

## 五、定稿工时估算

| 阶段 | 估时 | 风险 |
|---|---|---|
| 1 合并 chat-format | 5min | 极低 |
| 2 hook B 模型 | 1.5h | 低 |
| 3 hook F 输入 | 1h | 低 |
| 4 hook E 面板 | 2.5h | 中 |
| 5 hook D 编排（useReducer）| 3h | 中 |
| 6 handleSend 拆子函数 | 2h | 高 |
| 7 hook C 流式 | 5.5h | 最高 |
| 8 hook A 会话 | 2.5h | 中 |
| 9 收尾 | 1h | — |
| **合计** | **~19h（约 3 个工作日）** | |

---

## 六、风险清单（融合红蓝）

| # | 风险 | 概率 | 缓解 |
|---|---|---|---|
| R1 | stale closure（已修一颗，但 hook 化时还会冒新的）| 高 | 关键值用 ref 镜像；每个阶段手动验 abort/中断 |
| R2 | useEffect 依赖数组漏项 | 中 | 保留原依赖数组；tsc + 仔细 review |
| R3 | hook 间循环依赖 | 中 | 类型集中在 `types.ts`，hook 间不互相 import |
| R4 | handleSend 内拆改了行为 | 高 | 阶段 6 单独 commit，先原地拆跑测试，绿了再搬 |
| R5 | 测试盲区（mock 测覆盖不到真实 API）| 中 | 见下方测试策略 |
| R6 | hook A 协调层失控（红队警告）| 中 | 接受 ChatPage 留 ~200 行协调层，不强求 <600 行 |

---

## 七、测试策略

### 7.1 自动化护栏（每阶段必跑）

```bash
pnpm tsc --noEmit     # 0 错
pnpm test             # 1101 passed（基线）
pnpm build            # 通过
```

**红线**：测试数下降 = 拆分改了行为 = 立即回滚。

### 7.2 手动测试清单（高风险阶段后执行）

**阶段 5（hook D）后**：
- [ ] 新建对话发普通消息 → 正常回复
- [ ] 发复杂问题 → 触发对弈建议
- [ ] 触发完整对弈 → 三角色跑完 → 结果落库

**阶段 6（handleSend 拆子函数）后**：
- [ ] 普通文本对话
- [ ] 流式中点击停止（abort）→ 真的停了
- [ ] 模型限额 → 触发回退 → switchNotice 显示
- [ ] 重复问题 → 缓存命中 → cacheNotice 显示
- [ ] 拖入文件 → 附件正常处理
- [ ] Harness 警告显示

**阶段 7（hook C）后（最关键）**：
- [ ] 上述全部 + 排队 2-3 条消息
- [ ] 第一条发完中途切模型 → 续发用新模型（验刚修的地雷）
- [ ] 切换会话 → 旧流被 abort

### 7.3 关于新测试

**纯重构原则上不写新测试**。但阶段 6 拆 handleSend 时如果发现无覆盖的关键路径，可在该阶段补 1-2 个集成测试（红队建议），但不强求。

---

## 八、成功标准（修订版）

| 标准 | 目标 |
|---|---|
| ChatPage.tsx 行数 | **< 800 行**（含协调层；红队修正：原 <600 不现实）|
| 单个文件最大行数 | 无文件 > 800 行 |
| 单个函数最大行数 | 无函数 > 200 行（handleSend 拆后）|
| TypeScript | 0 错 |
| 测试 | 1101 passed（基线一致）|
| 构建 | 通过 |
| 行为 | 用户可见行为零变化 |

---

## 九、阶段产出目录（最终）

```
app/src/pages/
├── ChatPage.tsx                # < 800 行：hook 组合 + 会话协调层 + JSX
├── chat/
│   ├── types.ts                # 含合并后的 chat-format
│   ├── history.ts
│   ├── chain-messages.ts
│   ├── ...（已有 14 个纯逻辑模块）
│   ├── useChatAttachments.ts   # 已有
│   ├── useModelSelection.ts    # 新：阶段 2
│   ├── useChatInput.ts         # 新：阶段 3
│   ├── useWorkPanel.ts         # 新：阶段 4
│   ├── useOrchestration.ts     # 新：阶段 5（useReducer）
│   ├── useChatStream.ts        # 新：阶段 7
│   ├── useConversations.ts     # 新：阶段 8
│   └── components/             # 已有 8 个子组件
└── CHAT_PAGE_REFACTOR_PLAN.md  # 本文件
```

---

## 十、回滚预案

任何阶段三件套任一红，且 30 分钟内无法修复：

```bash
git reset --hard <该阶段开始前的 commit>
```

每阶段独立 commit，message 格式：`refactor(chat): 阶段N - 抽出 xxx`。
单个阶段出问题可 `git revert` 单条提交。
