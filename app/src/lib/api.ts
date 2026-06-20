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
  /** 能力分 JSON 字符串（喂给 autoAssignModels 做评分） */
  capabilityScore: string | null;
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

/**
 * Work role 枚举（v0.7 i18n 重构：label/description 移出常量，由 UI 层 t() 翻译）
 * 历史：v0.6 前 `{ value, label, description }` 都用硬编码中文，UI 切英文会显示中文。
 * 改后只剩 value 数组，UI 显示用 `t(\`workRoles.${value}\`)` 和 `t(\`workRoles.${value}_desc\`)`。
 */
export const WORK_ROLES = [
  "main_chat",
  "planning",
  "review",
  "frontend",
  "backend",
  "testing",
  "final_review",
  "data_exploration",
  "modeling",
  "ios",
  "android",
  "direct_generation",
  "general",
] as const;

export type WorkRole = (typeof WORK_ROLES)[number];
