// 工程化分层依赖方向检查（对应 Cosmgrid-Agent-工程化开发方案 L0-L12 的层间依赖规则）。
//
// 当前仅覆盖能对齐现有目录结构、且已核实不会误报的方向：
//   - lib/** (状态/业务逻辑层) 不允许依赖 pages/** 或 components/**（UI 层）。
//   - lib/db (L0 状态真相源) 不允许依赖 lib/llm、lib/workflow、lib/skills（上层不能被 L0 依赖）。
//   - lib/workflow (L9)、lib/skills (L7) 不允许直接依赖 UI 层。
//
// 只有真正的运行时/逻辑依赖（值导入、函数调用）才算违规；纯 `import type` 引用不算——持久化层
// 需要知道它存的数据长什么"形状"是正常的数据契约，不是逻辑耦合。用 dependencyTypesNot 排除
// type-only 依赖，只让「调用了上层函数/用了上层的值」的真实耦合报错。
//
// lib/llm 还没有完全按层拆成子目录，但已稳定的子边界先强制：
//   - harness 是 L8 审计层，不允许回头调用工具/UI/工作流运行时。
//   - tools 是 L6 工具层，不允许依赖 UI、workflow、skills。
//   - provider/CLI/错误分类/模型限制是 L1 接入底座，不允许依赖上层工具、workflow、UI。
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "warn",
      comment: "存在循环依赖，先确认是否必要，能拆的尽量拆开。",
      from: {},
      to: { circular: true },
    },
    {
      name: "lib-no-ui",
      severity: "error",
      comment:
        "lib/** 是状态/业务逻辑层，不允许反向依赖 pages/** 或 components/**（UI 层）的运行时值。" +
        "如果需要共享类型，把类型定义移到 lib 里，让 UI 组件从 lib 导入，而不是反过来。",
      from: { path: "^src/lib" },
      to: { path: "^src/(pages|components)", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "l0-state-independent",
      severity: "error",
      comment:
        "lib/db 是 L0 状态真相源，不允许依赖 lib/llm、lib/workflow、lib/skills 的运行时值/函数" +
        "（纯类型引用允许，因为持久化层需要知道存储数据的形状）。",
      from: { path: "^src/lib/db" },
      to: { path: "^src/lib/(llm|workflow|skills)", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "l9-workflow-no-ui",
      severity: "error",
      comment: "lib/workflow (L9 工作流引擎层) 不允许直接依赖 UI 层的运行时值。",
      from: { path: "^src/lib/workflow" },
      to: { path: "^src/(pages|components)", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "l7-skills-no-ui",
      severity: "error",
      comment: "lib/skills (L7 Skill 层) 不允许直接依赖 UI 层的运行时值。",
      from: { path: "^src/lib/skills" },
      to: { path: "^src/(pages|components)", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "l8-harness-no-upstack-runtime",
      severity: "error",
      comment: "lib/llm/harness (L8 审计层) 只能读证据/做判定，不允许反向调用工具、workflow 或 UI 运行时。",
      from: { path: "^src/lib/llm/harness" },
      to: { path: "^src/(pages|components)|^src/lib/(workflow|skills)|^src/lib/llm/tools", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "l8-evidence-no-workflow-tools-runtime",
      severity: "error",
      comment: "lib/llm/evidence (L8 证据链层) 不允许反向依赖 workflow 或 tools 的运行时值。" +
        " 需要类型时用 import type，需要函数时通过回调注入或参数传递。",
      from: { path: "^src/lib/llm/evidence" },
      to: {
        path: "^src/lib/(workflow|llm/tools)",
        pathNot: "^src/lib/llm/tools/result-contract$",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "l9-evals-no-ui-runtime",
      severity: "error",
      comment: "lib/evals (L9 评估层) 不允许反向依赖 UI 运行时。Grader 只消费结构化事实（tool_executions / workflow_runs / verifyTask），不调用 UI / 工具。",
      from: { path: "^src/lib/evals" },
      to: { path: "^src/(pages|components)", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "l10-playbook-no-ui-runtime",
      severity: "error",
      comment: "lib/llm/playbook (L10 上下文层) 不允许反向依赖 UI 运行时。Reflector / Curator / context-assembler 只消费结构化事实（project_memories / tool_executions / summary），不调用 UI / 工具。",
      from: { path: "^src/lib/llm/playbook" },
      to: { path: "^src/(pages|components)", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "l6-tools-no-upstack-runtime",
      severity: "error",
      comment: "lib/llm/tools (L6 工具层) 不允许依赖 UI、workflow、skills 的运行时值。",
      from: { path: "^src/lib/llm/tools" },
      to: { path: "^src/(pages|components)|^src/lib/(workflow|skills)", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "l1-llm-core-no-upstack-runtime",
      severity: "error",
      comment: "LLM 接入底座（provider/CLI/错误分类/模型限制）不允许依赖工具、workflow 或 UI 运行时。",
      from: {
        path: "^src/lib/llm/(provider-|provider\\.|cli-|chat-fallback-types|error-classifier|finish-reason|model-limits|sse-chunk-timeout)",
      },
      to: { path: "^src/(pages|components)|^src/lib/workflow|^src/lib/llm/tools", dependencyTypesNot: ["type-only"] },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
    exclude: { path: "^src/.*/__tests__" },
  },
};
