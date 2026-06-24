// 主对话「编排者」——后台滚动判断工作节点，按节点自动定模型
//
// 病根（产品真北）：主对话现在是"选一个模型一路聊到底"。规划、写代码、测试是不同的活，
// 该用不同的模型，但用户不该手动来回切。
//
// 解法：每轮回答后，用一个便宜模型在后台读对话历史，滚动判断"现在这活处在哪个工作节点"
// （规划 / 写代码 / 测试 / 审查 / 闲聊），并给每个节点定一个最合适的已接入模型。
// 全程折叠回执（一行小字），用户随时手点切换覆盖。
//
// 分层（本文件只管最上面一层）：
//   编排者（这里：定节点）→ pickBestModelForRole（按节点角色选模型）→ outcome 反馈（已有）
//
// 设计原则（照搬 checkpoint-generator 的哲学）：
//   1. LLM 只规划"节点结构"（不碰具体 modelId）——模型分配交给纯函数 resolveOrchestration，可离线测、可预测
//   2. 失败兜底：解析/调用出错由调用方接住，绝不影响主对话（编排是锦上添花，不是主流程）
//   3. 滚动规划：传入 prevState，让模型在已有节点图上增补/推进，而不是每次从零重排

import { generateObject } from "ai";
import { z } from "zod";
import type { LanguageModel } from "./provider-factory";
import { pickBestModelForRole, detectModelTier, type ScorableModel } from "./model-capabilities";
import type { WorkRole } from "../api";

/** 工作节点类型（给用户看的"活的阶段"，比 13 个 workRoles 更聚焦，LLM 判得更准） */
export const NODE_KINDS = ["planning", "coding", "testing", "review", "chat"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** 节点类型 → 用于模型评分的 workRole（复用 model-capabilities 的角色能力分） */
const NODE_KIND_TO_ROLE: Record<NodeKind, WorkRole> = {
  planning: "planning",
  coding: "backend", // backend 归"重执行/coding"类，代表通用写代码
  testing: "testing",
  review: "review",
  chat: "main_chat",
};

export type NodeStatus = "planned" | "active" | "done";

export interface OrchestrationNode {
  id: string;
  kind: NodeKind;
  title: string;
  status: NodeStatus;
  /** 该节点当前绑定的模型 id（编排自动定，或用户手动指定） */
  modelId: string | null;
  /** 用户手动指定过这个节点的模型 → 编排不再自动覆盖（尊重接管） */
  pinned: boolean;
}

/** 落库到 conversations.orchestration 的整体状态 */
export interface OrchestrationState {
  version: number;
  nodes: OrchestrationNode[];
  currentNodeId: string | null;
  updatedAt: string;
}

export const ORCHESTRATION_VERSION = 1;

/** LLM 输出的节点规划（只规划结构，不碰 modelId） */
const planSchema = z.object({
  currentNodeKind: z.enum(NODE_KINDS).describe("当前对话进行到哪个工作节点"),
  nodes: z
    .array(
      z.object({
        kind: z.enum(NODE_KINDS),
        title: z.string().describe("这个节点在做什么，简短一句，如「搭项目骨架」"),
        status: z.enum(["planned", "active", "done"]),
      }),
    )
    .min(1)
    .describe("这个项目/任务从头到尾的工作节点列表，按推进顺序"),
  reason: z.string().describe("为什么这样判断，一句话"),
});

export type OrchestrationPlan = z.infer<typeof planSchema>;

export interface OrchestrationTurn {
  role: "user" | "assistant" | "system";
  content: string;
}

/** 节点最小可分配模型形状（兼容 ModelListItem） */
export type AssignableModel = ScorableModel;

const NODE_KIND_LABELS: Record<NodeKind, string> = {
  planning: "规划/设计方案",
  coding: "写代码/实现功能",
  testing: "写测试/跑测试",
  review: "审查/复核代码",
  chat: "普通对话/答疑",
};

/**
 * 用一个（便宜的）模型读对话历史，滚动规划工作节点。
 * 只产出节点结构 + 当前节点，不碰模型分配（那是 resolveOrchestration 的纯函数活）。
 * 失败不在此吞掉——调用方负责兜底（编排失败不该影响主对话）。
 */
export async function planNodes(
  languageModel: LanguageModel,
  history: OrchestrationTurn[],
  prevState?: OrchestrationState | null,
): Promise<OrchestrationPlan> {
  const transcript =
    history.length > 0
      ? history.map((m) => `[${m.role}] ${m.content}`).join("\n\n")
      : "（这段对话还没有任何内容）";

  const prevPlan =
    prevState && prevState.nodes.length > 0
      ? prevState.nodes.map((n) => `- [${n.status}] ${n.kind}：${n.title}`).join("\n")
      : "（还没有规划过节点，这是第一次）";

  const kindMenu = NODE_KINDS.map((k) => `  - ${k}：${NODE_KIND_LABELS[k]}`).join("\n");

  const { object } = await generateObject({
    model: languageModel,
    schema: planSchema,
    prompt: `你是一个「工作节点编排者」。下面是用户和 AI 的对话记录。请判断这个任务从头到尾会经过哪些工作节点，以及现在进行到哪个节点。

可选的节点类型（只能从这几种里选）：
${kindMenu}

规则：
- 滚动规划：基于已有节点图增补/推进，不要推翻重来。已经完成的节点保留并标 done。
- 节点要贴合对话里**真实发生**的活，不要凭空规划用户没提过的阶段。
- 简单的闲聊/答疑就只给一个 chat 节点即可，不要硬凑出"规划→写码→测试"。
- currentNodeKind 必须是 nodes 里某个节点的 kind。

已有节点图：
${prevPlan}

对话记录：
${transcript}`,
  });

  return object;
}

let nodeCounter = 0;
function newNodeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  nodeCounter += 1;
  return `node-${Date.now()}-${nodeCounter}`;
}

/**
 * 纯函数：把 LLM 的节点规划 + 旧状态，合并成新的 OrchestrationState，并给每个节点定模型。
 * - 按 kind 继承旧节点的 id / pinned / modelId（保住用户接管的选择）
 * - 未被用户钉住（pinned=false）的节点 → 用 pickBestModelForRole 自动定该角色最合适的模型
 * - currentNodeId 指向 plan.currentNodeKind 对应的节点
 *
 * @param now 注入时间戳便于测试；不传用当前时间
 */
export function resolveOrchestration(
  plan: OrchestrationPlan,
  models: AssignableModel[],
  prevState?: OrchestrationState | null,
  now: () => string = () => new Date().toISOString(),
): OrchestrationState {
  // 旧节点按 kind 分组（同 kind 可能多个，逐个消费，先到先继承）
  const prevByKind = new Map<NodeKind, OrchestrationNode[]>();
  for (const n of prevState?.nodes ?? []) {
    const arr = prevByKind.get(n.kind) ?? [];
    arr.push({ ...n });
    prevByKind.set(n.kind, arr);
  }

  const nodes: OrchestrationNode[] = plan.nodes.map((pn) => {
    const inherited = prevByKind.get(pn.kind)?.shift();
    const id = inherited?.id ?? newNodeId();
    const pinned = inherited?.pinned ?? false;

    // 钉住的节点：保留用户选的模型；否则按角色自动选最合适的
    let modelId: string | null;
    if (pinned && inherited?.modelId) {
      modelId = inherited.modelId;
    } else {
      const picked = pickBestModelForRole(NODE_KIND_TO_ROLE[pn.kind], models);
      modelId = picked?.id ?? inherited?.modelId ?? null;
    }

    return { id, kind: pn.kind, title: pn.title, status: pn.status, modelId, pinned };
  });

  // 当前节点：优先取 currentNodeKind 里状态为 active 的，否则该 kind 第一个，否则第一个节点
  const sameKind = nodes.filter((n) => n.kind === plan.currentNodeKind);
  const current = sameKind.find((n) => n.status === "active") ?? sameKind[0] ?? nodes[0] ?? null;

  return {
    version: ORCHESTRATION_VERSION,
    nodes,
    currentNodeId: current?.id ?? null,
    updatedAt: now(),
  };
}

/** 取当前节点（找不到返回 null） */
export function currentNode(state: OrchestrationState | null): OrchestrationNode | null {
  if (!state) return null;
  return state.nodes.find((n) => n.id === state.currentNodeId) ?? null;
}

/**
 * 用户手动把某模型指定给「指定节点」→ 钉住该节点（pinned=true），编排后续不再自动覆盖。
 * 可钉任意节点（含还没轮到的 planned 节点）——用户可提前给"下个任务"指定模型。
 * 纯函数，返回新 state（不可变）。
 */
export function pinModelToNode(
  state: OrchestrationState,
  nodeId: string,
  modelId: string,
  now: () => string = () => new Date().toISOString(),
): OrchestrationState {
  return {
    ...state,
    nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, modelId, pinned: true } : n)),
    updatedAt: now(),
  };
}

/** 钉模型到当前节点（pinModelToNode 的便捷封装） */
export function pinModelToCurrentNode(
  state: OrchestrationState,
  modelId: string,
  now: () => string = () => new Date().toISOString(),
): OrchestrationState {
  if (!state.currentNodeId) return { ...state, updatedAt: now() };
  return pinModelToNode(state, state.currentNodeId, modelId, now);
}

export interface OrchestrationChange {
  /** 是否进入了新节点（当前节点 id 变了） */
  nodeChanged: boolean;
  /** 当前节点绑定的模型是否变了（用于决定要不要自动切 + 写回执） */
  modelChanged: boolean;
  node: OrchestrationNode | null;
  /** 变化前当前节点的模型（用于回执文案） */
  prevModelId: string | null;
}

/**
 * 纯函数：对比新旧状态，告诉 ChatPage「该不该自动切模型 + 写回执」。
 * - 全新状态（prev 为空）且有当前节点 → 算作进入节点
 */
export function diffOrchestration(
  prev: OrchestrationState | null,
  next: OrchestrationState,
): OrchestrationChange {
  const nextNode = currentNode(next);
  const prevNode = currentNode(prev);
  const nodeChanged = (prevNode?.id ?? null) !== (nextNode?.id ?? null);
  const prevModelId = prevNode?.modelId ?? null;
  const modelChanged = prevModelId !== (nextNode?.modelId ?? null);
  return { nodeChanged, modelChanged, node: nextNode, prevModelId };
}

/** 把状态序列化成可落库的 JSON 字符串 */
export function serializeOrchestration(state: OrchestrationState): string {
  return JSON.stringify(state);
}

/** 安全解析落库的 JSON（坏数据/旧版本/null 一律返回 null，绝不抛错） */
export function parseOrchestration(json: string | null): OrchestrationState | null {
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as unknown;
    if (
      obj &&
      typeof obj === "object" &&
      Array.isArray((obj as OrchestrationState).nodes) &&
      (obj as OrchestrationState).version === ORCHESTRATION_VERSION
    ) {
      return obj as OrchestrationState;
    }
    return null;
  } catch {
    return null;
  }
}

/** 选一个最省的模型来跑编排（编排是粗活）：优先 fast 档，否则数组第一个 */
export function pickOrchestratorModel<T extends { name: string }>(models: T[]): T | null {
  if (models.length === 0) return null;
  const fast = models.find((m) => detectModelTier(m.name) === "fast");
  return fast ?? models[0]!;
}
