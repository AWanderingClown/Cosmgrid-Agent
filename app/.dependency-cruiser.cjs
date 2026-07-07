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
// lib/llm 目前混杂 L1(接入)/L2(调度)/L6(工具)/L8(harness) 多层，尚未按层拆分子目录，
// 因此暂时无法对 lib/llm 内部做更细的层间规则；这是已知缺口，见方案 Phase 0 遗留项，
// 拆分完成后需要在这里补充 L1→L2→L6→L8 的方向规则。
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
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
    exclude: { path: "^src/.*/__tests__" },
  },
};
