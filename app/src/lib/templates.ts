// 内置项目模板定义（4.13.3）：只定义角色清单，具体模型由用户在模板页分配
// 对应 project_templates 表的 4 条 isBuiltIn=true 种子数据
// v0.7 i18n 化：name/description 加 i18nKey 字段，UI 用 t(i18nKey) 翻译

export interface BuiltInTemplateDef {
  /** 内部 key（用作 DB 唯一标识 + 模板匹配），不翻 */
  name: string;
  /** i18n key for t() translation of name */
  nameKey: "fullstack_web" | "data_science" | "mobile_app" | "small_script";
  descriptionKey: "fullstack_web" | "data_science" | "mobile_app" | "small_script";
  icon: string;
  workRoles: string[];
}

export const BUILT_IN_TEMPLATES: BuiltInTemplateDef[] = [
  {
    name: "全栈 Web 项目模板",
    nameKey: "fullstack_web",
    descriptionKey: "fullstack_web",
    icon: "Globe",
    workRoles: ["main_chat", "planning", "review", "frontend", "backend", "testing", "final_review"],
  },
  {
    name: "数据科学项目模板",
    nameKey: "data_science",
    descriptionKey: "data_science",
    icon: "BarChart3",
    workRoles: ["main_chat", "planning", "review", "data_exploration", "modeling", "testing", "final_review"],
  },
  {
    name: "移动 App 模板",
    nameKey: "mobile_app",
    descriptionKey: "mobile_app",
    icon: "Smartphone",
    workRoles: ["main_chat", "planning", "review", "ios", "android", "testing", "final_review"],
  },
  {
    name: "小型脚本模板",
    nameKey: "small_script",
    descriptionKey: "small_script",
    icon: "FileCode",
    workRoles: ["main_chat", "direct_generation", "testing"],
  },
];
