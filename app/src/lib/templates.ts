// 内置项目模板定义（4.13.3）：只定义角色清单，具体模型由用户在模板页分配
// 对应 project_templates 表的 4 条 isBuiltIn=true 种子数据

export interface BuiltInTemplateDef {
  name: string;
  description: string;
  icon: string;
  workRoles: string[];
}

export const BUILT_IN_TEMPLATES: BuiltInTemplateDef[] = [
  {
    name: "全栈 Web 项目模板",
    description: "main_chat / planning / review / frontend / backend / testing / final_review",
    icon: "Globe",
    workRoles: ["main_chat", "planning", "review", "frontend", "backend", "testing", "final_review"],
  },
  {
    name: "数据科学项目模板",
    description: "main_chat / planning / review / data_exploration / modeling / testing / final_review",
    icon: "BarChart3",
    workRoles: ["main_chat", "planning", "review", "data_exploration", "modeling", "testing", "final_review"],
  },
  {
    name: "移动 App 模板",
    description: "main_chat / planning / review / ios / android / testing / final_review",
    icon: "Smartphone",
    workRoles: ["main_chat", "planning", "review", "ios", "android", "testing", "final_review"],
  },
  {
    name: "小型脚本模板",
    description: "main_chat / direct_generation / testing（适合一次性脚本生成）",
    icon: "FileCode",
    workRoles: ["main_chat", "direct_generation", "testing"],
  },
];
