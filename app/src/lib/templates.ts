// 内置项目模板定义（4.13.3）：只定义角色清单，具体模型由用户在模板页分配
// 当前只保留“默认 8 角色”作为可见内置模板；旧 4 个内置模板只归档隐藏，不删库。
// v0.7 i18n 化：name/description 加 i18nKey 字段，UI 用 t(i18nKey) 翻译
//
// 阶段 D 引入第 5 张"默认 8 角色"模板：workRoles 是 8 RoleId（leader/architect/frontend/backend/runner/tester/reviewer/security），
// 跟老 4 张模板的 13 workRole 枚举（main_chat/planning/...）不是一个 schema 概念。
// 这张模板是 ChatPage 无 project 时的角色绑定兜底 —— 主对话不绑项目也能在 TemplatesPage 编辑 8 角色 → 编排真生效。

export interface BuiltInTemplateDef {
  /** 内部 key（用作 DB 唯一标识 + 模板匹配），不翻 */
  name: string;
  /** i18n key for t() translation of name */
  nameKey: "default_eight_roles";
  descriptionKey: "default_eight_roles";
  icon: string;
  workRoles: string[];
}

export const RETIRED_BUILT_IN_TEMPLATE_NAMES = [
  "全栈 Web 项目模板",
  "数据科学项目模板",
  "移动 App 模板",
  "小型脚本模板",
] as const;

export const BUILT_IN_TEMPLATES: BuiltInTemplateDef[] = [
  {
    // 阶段 D：默认 8 角色（RoleId，leader/architect/.../security）
    // ChatPage 主对话无 project 时用这张；用户在 TemplatesPage 编辑 → resolveOrchestration 真生效
    name: "默认 8 角色",
    nameKey: "default_eight_roles",
    descriptionKey: "default_eight_roles",
    icon: "Users",
    workRoles: ["leader", "architect", "frontend", "backend", "runner", "tester", "reviewer", "security"],
  },
];
