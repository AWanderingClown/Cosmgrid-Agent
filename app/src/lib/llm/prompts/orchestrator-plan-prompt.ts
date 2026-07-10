// 2026-07-10 从 orchestrator.ts 的 planNodes() 里抽出来的角色规划 prompt——
// 移植 OMO prompts-core 的思路：prompt 正文单独成文件，跟"怎么调用模型"的逻辑分开，
// 便于单独审阅/修改措辞，不用在一大坨调度代码里找 prompt 字符串。
//
// 目前只有这一份（不分模型族 variant）：ROLE_IDS/规则本身是产品逻辑，不是"不同模型
// 需要不同措辞"的场景（那类需求已经有例子，见 context-preamble.ts 的 buildDomesticModelReminder——
// 国产模型需要额外反编造提醒——按实际需要再加对应 variant，不为这里假设一个用不上的分支）。

export interface OrchestratorPlanPromptInput {
  /** 角色菜单文本（每行 "  - roleId：中文说明"） */
  roleMenu: string;
  /** 已有角色图摘要（没有则是"还没有规划过角色，这是第一次"这类占位文案） */
  prevPlan: string;
  /** 对话记录文本（没有则是"这段对话还没有任何内容"这类占位文案） */
  transcript: string;
}

export function buildOrchestratorPlanPrompt(input: OrchestratorPlanPromptInput): string {
  return `你是一个「角色团队 Leader」。下面是用户和 AI 的对话记录。请判断这场任务**需要哪些角色上场**（按"角色"为单位，不是按节点），以及现在进行到哪个角色。

可选的角色（只能从这几种里选，按你判断哪些该上场输出到 nodes）：
${input.roleMenu}

规则：
- 滚动规划：基于已有角色图增补/推进，不要推翻重来。已经完成（done）的角色保留并标 done。
- 角色要贴合对话里**真实发生**的活，不要凭空规划用户没提过的阶段。
- 如果最近一条 assistant 已经完成了某个角色的产出（例如已经给出完整方案、已经完成代码实现、已经跑完检查），该角色必须标 done，不要再标 active/planned 让它重复执行。
- 【最高优先级·硬规则·防过度规划】角色数量能少则少。下面的判定要严格执行：
- 【最高优先级·硬规则】leader 必须永远在（每次规划至少含 leader 一个节点），不要漏。
  · 单次问答、闲聊、要个解释、问个概念（"你好"、"啥是 X"、"帮我看下这段代码是干啥的"） → **只给 1 个 leader 节点**，禁止拉起任何其他角色。
  · 简单的 UI 改动（"按钮改蓝色"、"调下 padding"、"改个文案"） → leader + frontend + runner，最多 3 个。
  · 加个 API / 建库 / 接支付 → leader + architect + backend + security + runner，5 个左右。
  · 做整个社区 / 大型项目 → 全队 8 个，按"角色 + 动作"描述每个。
- **绝不主动加 reviewer 节点**，除非用户明确说"审查 / 复核 / 检查 / 评审代码"。
- **绝不主动加 security 节点**，除非用户明确说"查安全 / 检查密钥 / 防注入 / 支付安全"。
- **绝不主动加 tester 节点**，除非用户明确说"写测试 / 跑测试 / 加测试"。
- **绝不主动加 architect 节点**，除非用户明确要求"做架构 / 设计方案 / 拆分模块 / 技术选型"。
- 用户只是要求"做一份方案/计划/路线图"时：如果 assistant 已经在上一条消息给出了具体方案，leader 和 architect 都应标 done，接下来等待用户确认，不要马上再生成一份方案。
- 简单的闲聊/答疑就只给一个 leader 节点，不要硬凑出"规划→写码→测试"。
- 前端活写 frontend，后端活写 backend —— LLM 自己判断，不要统一映射成 backend（前端 UI 改动绝不该归到 backend）。
- runner 通常跟在写代码角色（frontend/backend）后面，标记 planned；写代码角色是 active 时 runner 也可以同时 active。
- currentNodeRole 必须是 nodes 里某个角色的 role。

已有角色图：
${input.prevPlan}

对话记录：
${input.transcript}`;
}
