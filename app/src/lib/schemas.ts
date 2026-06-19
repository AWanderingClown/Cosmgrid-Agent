// Zod 验证 schemas（CLAUDE.md TypeScript 规则：Input Validation 用 Zod）
// 用于 CRUD API 的入参验证
import { z } from "zod";

// ============ 通用类型 ============

const cuidSchema = z.string().min(1);
const timestampSchema = z.string().datetime().or(z.date());

// ============ 资源层（4 张）============

// Provider
export const createProviderSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.string().min(1).max(50),
  website: z.string().url().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});
export const updateProviderSchema = createProviderSchema.partial();

// ApiCredential
export const createApiCredentialSchema = z.object({
  providerId: cuidSchema,
  name: z.string().min(1).max(100),
  baseUrl: z.string().url(),
  apiKeyEncrypted: z.string().min(1),
  enabled: z.boolean().default(true),
  supportsStreaming: z.boolean().default(true),
  supportsFunctionCall: z.boolean().default(true),
  supportsVision: z.boolean().default(false),
  defaultModelId: cuidSchema.optional().nullable(),
});
export const updateApiCredentialSchema = createApiCredentialSchema.partial();

// TokenPlan
export const createTokenPlanSchema = z.object({
  providerId: cuidSchema,
  linkedApiCredentialId: cuidSchema.optional().nullable(),
  name: z.string().min(1).max(100),
  planType: z.string().min(1).max(50),
  quotaUnit: z.string().min(1).max(20),
  totalQuota: z.number().nonnegative().optional().nullable(),
  usedQuota: z.number().nonnegative().default(0),
  resetRule: z.string().max(200).optional().nullable(),
  nextResetAt: timestampSchema.optional().nullable(),
  warningThresholds: z.string().optional().nullable(),
  status: z.string().default("active"),
  autoTrackEnabled: z.boolean().default(false),
  manualUpdateRequired: z.boolean().default(false),
  fallbackModelId: cuidSchema.optional().nullable(),
});
export const updateTokenPlanSchema = createTokenPlanSchema.partial();

// Model
const capabilityTagsSchema = z.string().refine(
  (val) => {
    try {
      const arr = JSON.parse(val);
      return Array.isArray(arr) && arr.every((t) => typeof t === "string");
    } catch {
      return false;
    }
  },
  { message: "capabilityTags 必须是 JSON 字符串数组" },
);

const capabilityScoreSchema = z.string().refine(
  (val) => {
    try {
      const obj = JSON.parse(val);
      return typeof obj === "object" && obj !== null && !Array.isArray(obj);
    } catch {
      return false;
    }
  },
  { message: "capabilityScore 必须是 JSON 字符串对象" },
);

const workRolesSchema = z.string().refine(
  (val) => {
    try {
      const arr = JSON.parse(val);
      return Array.isArray(arr) && arr.length > 0 && arr.every((t) => typeof t === "string");
    } catch {
      return false;
    }
  },
  { message: "workRoles 必须是 JSON 字符串数组（至少 1 项）" },
);

export const createModelSchema = z.object({
  providerId: cuidSchema,
  name: z.string().min(1).max(100),
  displayName: z.string().max(100).optional().nullable(),
  contextWindow: z.number().int().positive().optional().nullable(),
  inputPrice: z.number().nonnegative().optional().nullable(),
  outputPrice: z.number().nonnegative().optional().nullable(),
  capabilityTags: capabilityTagsSchema.optional().nullable(),
  capabilityScore: capabilityScoreSchema.optional().nullable(),
  workRoles: workRolesSchema, // 必填
  enabled: z.boolean().default(true),
});
export const updateModelSchema = createModelSchema.partial();

// ============ 模板层（2 张）============

export const createProjectTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional().nullable(),
  icon: z.string().max(200).optional().nullable(),
  isBuiltIn: z.boolean().default(false),
  isDefault: z.boolean().default(false),
});
export const updateProjectTemplateSchema = createProjectTemplateSchema.partial();

export const createProjectTemplateRoleSchema = z.object({
  templateId: cuidSchema,
  workRole: z.enum([
    "main_chat",
    "planning",
    "review",
    "frontend",
    "backend",
    "testing",
    "final_review",
  ]),
  modelId: cuidSchema,
  fallbackModelId: cuidSchema.optional().nullable(),
  order: z.number().int().nonnegative().default(0),
  systemPrompt: z.string().max(10000).optional().nullable(),
  enabled: z.boolean().default(true),
});
export const updateProjectTemplateRoleSchema = createProjectTemplateRoleSchema.partial();

// ============ 任务层（5 张）============

export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional().nullable(),
  templateId: cuidSchema.optional().nullable(),
  currentStage: z
    .enum([
      "main_chat",
      "planning",
      "frontend",
      "backend",
      "testing",
      "final_review",
      "completed",
      "failed",
    ])
    .default("main_chat"),
  status: z
    .enum(["pending", "active", "paused", "completed", "failed"])
    .default("pending"),
  workspacePath: z.string().max(500).optional().nullable(),
});
export const updateProjectSchema = createProjectSchema.partial();

export const createProjectStageSchema = z.object({
  projectId: cuidSchema,
  workRole: z.enum([
    "main_chat",
    "planning",
    "review",
    "frontend",
    "backend",
    "testing",
    "final_review",
  ]),
  modelId: cuidSchema,
  startedAt: timestampSchema.optional().nullable(),
  completedAt: timestampSchema.optional().nullable(),
  status: z
    .enum(["pending", "running", "completed", "failed", "interrupted"])
    .default("pending"),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cost: z.number().nonnegative().default(0),
  outputSummary: z.string().max(5000).optional().nullable(),
  errorMessage: z.string().max(2000).optional().nullable(),
});
export const updateProjectStageSchema = createProjectStageSchema.partial();

export const createConversationSchema = z.object({
  projectId: cuidSchema.optional().nullable(),
  title: z.string().min(1).max(200),
  defaultModelId: cuidSchema.optional().nullable(),
});
export const updateConversationSchema = createConversationSchema.partial();

export const createMessageSchema = z.object({
  conversationId: cuidSchema,
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string().min(1),
  modelId: cuidSchema.optional().nullable(),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cost: z.number().nonnegative().default(0),
});
// Message 不允许 update（v0.1 暂不支持编辑历史消息）
export const createConversationModelSnapshotSchema = z.object({
  conversationId: cuidSchema,
  modelId: cuidSchema,
  switchedAt: timestampSchema.optional().nullable(),
  messageCount: z.number().int().nonnegative().default(0),
  totalInputTokens: z.number().int().nonnegative().default(0),
  totalOutputTokens: z.number().int().nonnegative().default(0),
  note: z.string().max(500).optional().nullable(),
});
export const updateConversationModelSnapshotSchema =
  createConversationModelSnapshotSchema.partial();

// ============ v0.2 Chat 层 ============

/** 单条消息（user / assistant / system） */
export const messageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
});

/** 通用 chat 请求（stream + sync 都用） */
export const chatRequestSchema = z.object({
  modelId: cuidSchema,
  credentialId: cuidSchema,
  /** 前端解密后的明文 API Key（不持久化） */
  apiKey: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

/** 测试连接请求（无需 DB 记录） */
export const testConnectionSchema = z.object({
  providerType: z.string().min(1),
  modelName: z.string().min(1),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

/** 模型过滤 query（?workRoles=xxx&enabled=xxx） */
export const modelFilterQuerySchema = z.object({
  workRoles: z.string().optional(),
  enabled: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

// ============ 连续性层（2 张：checkpoint / handoff_packet）============

/** targetRole 比 stage.workRole 更宽——含数据科学 / 移动端等模板 */
export const targetRoleEnum = z.enum([
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
]);

export const createCheckpointSchema = z.object({
  projectId: cuidSchema,
  title: z.string().min(1).max(200),
  goal: z.string().max(5000).optional().nullable(),
  completedSummary: z.string().max(5000).optional().nullable(),
  currentContext: z.string().max(5000).optional().nullable(),
  decisions: z.string().max(5000).optional().nullable(),
  failedAttempts: z.string().max(5000).optional().nullable(),
  blockers: z.string().max(5000).optional().nullable(),
  nextSteps: z.string().max(5000).optional().nullable(),
  doNotRepeat: z.string().max(5000).optional().nullable(),
  acceptanceCriteria: z.string().max(5000).optional().nullable(),
  createdByModelId: cuidSchema.optional().nullable(),
});
export const updateCheckpointSchema = createCheckpointSchema.partial();

export const createHandoffPacketSchema = z.object({
  projectId: cuidSchema,
  checkpointId: cuidSchema,
  targetRole: targetRoleEnum,
  targetModelId: cuidSchema.optional().nullable(),
  format: z.string().default("markdown"),
  content: z.string().min(1),
});