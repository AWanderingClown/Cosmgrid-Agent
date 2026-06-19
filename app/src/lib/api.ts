// 共享 API 类型（v0.3：fetch wrapper 已移除，改用 src/lib/db.ts 直连 SQLite）

/** API 调用错误 */
export class ApiError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = "ApiError";
  }
}

// ============ 共享数据类型 ============

export interface ProviderListItem {
  id: string;
  name: string;
  type: string;
  website: string | null;
}

export interface CredentialListItem {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  providerId: string;
  provider: { name: string; type: string };
  defaultModelId: string | null;
}

export interface ModelListItem {
  id: string;
  name: string;
  displayName: string | null;
  contextWindow: number | null;
  enabled: boolean;
  workRoles: string;
  providerId: string;
  provider?: { name: string; type: string };
}

export function parseWorkRoles(json: string): string[] {
  try {
    return JSON.parse(json) as string[];
  } catch {
    return [];
  }
}

export const WORK_ROLES = [
  { value: "main_chat", label: "主对话", description: "用户跟 AI 的直接对话" },
  { value: "planning", label: "计划阶段", description: "任务分解、架构设计" },
  { value: "review", label: "代码 review", description: "PR/代码审查" },
  { value: "frontend", label: "前端实现", description: "UI/CSS/组件" },
  { value: "backend", label: "后端实现", description: "API/DB/服务" },
  { value: "testing", label: "测试", description: "单测/集成测试" },
  { value: "final_review", label: "最终审核", description: "完整方案复核" },
  { value: "data_exploration", label: "数据探索", description: "数据科学项目：探索性分析" },
  { value: "modeling", label: "建模", description: "数据科学项目：模型训练" },
  { value: "ios", label: "iOS 实现", description: "移动 App 项目：iOS 端" },
  { value: "android", label: "Android 实现", description: "移动 App 项目：Android 端" },
  { value: "direct_generation", label: "直接生成", description: "小型脚本：一次性直出代码" },
  { value: "general", label: "通用兜底", description: "无明确角色时" },
] as const;

export type WorkRole = (typeof WORK_ROLES)[number]["value"];
