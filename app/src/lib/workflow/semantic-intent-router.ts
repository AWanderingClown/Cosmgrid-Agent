import { keywordEmbed } from "@/lib/llm/embedding";
import { cosineSimilarity } from "@/lib/llm/similarity";
import { BUILTIN_ACTION_MARKERS, resolveIntentActionMarkers } from "@/lib/policy/intent-action-markers";

export type IntentRouteAction =
  | "answer_only"
  | "start_run"
  | "continue_run"
  | "review"
  | "debate"
  | "execute"
  | "verify"
  | "plan"
  | "reject_node"
  | "pause_run"
  | "cancel_run";

export interface IntentExample {
  id: string;
  action: IntentRouteAction;
  text: string;
  explanation: string;
  source: "builtin" | "user_correction" | "accepted_decision";
  weight: number;
  enabled: boolean;
}

export interface IntentRouteCandidate {
  action: IntentRouteAction;
  score: number;
  margin: number;
  matchedExample: IntentExample;
}

export interface SemanticIntentRoute {
  candidates: IntentRouteCandidate[];
  top: IntentRouteCandidate | null;
  confidence: number;
  noMatch: boolean;
}

export const BUILTIN_INTENT_EXAMPLES: IntentExample[] = [
  {
    id: "answer-revise-article",
    action: "answer_only",
    text: "这篇公众号软文太硬了，改得自然一点",
    explanation: "用户只是在修改表达风格，不是启动执行、评审或博弈。",
    source: "builtin",
    weight: 1.1,
    enabled: true,
  },
  {
    id: "answer-explain",
    action: "answer_only",
    text: "解释一下这是什么意思",
    explanation: "普通解释性问题，继续对话即可。",
    source: "builtin",
    weight: 1,
    enabled: true,
  },
  {
    id: "start-read-project",
    action: "start_run",
    text: "全面盘查项目，深入理解产品和已经实现的功能",
    explanation: "用户要开始一个项目理解任务。",
    source: "builtin",
    weight: 1.15,
    enabled: true,
  },
  {
    id: "start-write-doc",
    action: "start_run",
    text: "先分析项目，然后写一篇推广软文",
    explanation: "用户要开始一条内容交付任务流。",
    source: "builtin",
    weight: 1.05,
    enabled: true,
  },
  {
    id: "continue-next",
    action: "continue_run",
    text: "继续吧，进入下一步",
    explanation: "用户要求沿当前任务流继续推进。",
    source: "builtin",
    weight: 1,
    enabled: true,
  },
  {
    id: "plan-solution",
    action: "plan",
    text: "先给我一份完整方案和落地计划",
    explanation: "用户要方案或计划。",
    source: "builtin",
    weight: 1,
    enabled: true,
  },
  {
    id: "review-other-ai",
    action: "review",
    text: "让另外一个 AI 评估一下这个方案",
    explanation: "用户要另一个模型复核，不是多方互相辩论。",
    source: "builtin",
    weight: 1.25,
    enabled: true,
  },
  {
    id: "review-critic",
    action: "review",
    text: "找个审查者帮我挑一下漏洞",
    explanation: "用户要评审和挑问题。",
    source: "builtin",
    weight: 1.15,
    enabled: true,
  },
  {
    id: "debate-multi-model",
    action: "debate",
    text: "让几个模型站不同立场互相反驳，最后给裁判结论",
    explanation: "用户要多方反驳和裁决。",
    source: "builtin",
    weight: 1.25,
    enabled: true,
  },
  {
    id: "debate-pro-con",
    action: "debate",
    text: "正方反方 PK 一下，最后裁判选一个方案",
    explanation: "用户明确要正反方博弈。",
    source: "builtin",
    weight: 1.15,
    enabled: true,
  },
  {
    id: "execute-code",
    action: "execute",
    text: "按这个方案开始改代码并落地实现",
    explanation: "用户要求进入实现和写代码。",
    source: "builtin",
    weight: 1.2,
    enabled: true,
  },
  {
    id: "execute-build-feature",
    action: "execute",
    text: "直接把这个功能做出来",
    explanation: "用户要求执行实现。",
    source: "builtin",
    weight: 1.05,
    enabled: true,
  },
  {
    id: "verify-tests",
    action: "verify",
    text: "跑一下测试，检查有没有问题",
    explanation: "用户要求验证结果。",
    source: "builtin",
    weight: 1.15,
    enabled: true,
  },
  {
    id: "verify-build",
    action: "verify",
    text: "构建一下，确认能不能通过",
    explanation: "用户要求构建或检查。",
    source: "builtin",
    weight: 1,
    enabled: true,
  },
  {
    id: "reject-redo",
    action: "reject_node",
    text: "不对，不是这个意思，重来",
    explanation: "用户打回当前结果。",
    source: "builtin",
    weight: 1.1,
    enabled: true,
  },
  {
    id: "pause-work",
    action: "pause_run",
    text: "先暂停，等一下",
    explanation: "用户要暂停当前任务。",
    source: "builtin",
    weight: 1,
    enabled: true,
  },
  {
    id: "cancel-work",
    action: "cancel_run",
    text: "取消这个任务，不要继续了",
    explanation: "用户要取消当前任务。",
    source: "builtin",
    weight: 1,
    enabled: true,
  },
];

// 引擎化阶段 2：关键词端默认走 builtin；hydrateIntentActionMarkers() 启动时从 PolicyStore
// （distribution scope）resolve 一次覆盖。当前无 distribution 写入通道 → 运行时等于 builtin；
// 形态与 command-allowlist 统一、resolve 不再是死代码，运营侧通道就绪后立即生效。
let ACTION_MARKERS: Readonly<Record<string, ReadonlyArray<string>>> = BUILTIN_ACTION_MARKERS;
let actionMarkersHydrated = false;

/** 启动时调用一次（chat-fallback 入口）；幂等，distribution override 缺失时保持 builtin。 */
export async function hydrateIntentActionMarkers(): Promise<void> {
  if (actionMarkersHydrated) return;
  ACTION_MARKERS = await resolveIntentActionMarkers();
  actionMarkersHydrated = true;
}

function markerScore(text: string, action: IntentRouteAction): number {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const marker of ACTION_MARKERS[action] ?? []) {
    if (lower.includes(marker.toLowerCase())) hits += 1;
  }
  return Math.min(0.24, hits * 0.08);
}

function scoreExample(text: string, example: IntentExample): number {
  const semantic = cosineSimilarity(keywordEmbed(text), keywordEmbed(example.text));
  const marker = markerScore(text, example.action);
  const weighted = semantic * 0.78 + marker;
  return Math.min(1, weighted * example.weight);
}

export function routeTurnIntentSemantically(
  text: string,
  examples: IntentExample[] = BUILTIN_INTENT_EXAMPLES,
): SemanticIntentRoute {
  const enabledExamples = examples.filter((e) => e.enabled);
  const bestByAction = new Map<IntentRouteAction, IntentRouteCandidate>();

  for (const example of enabledExamples) {
    const score = scoreExample(text, example);
    const existing = bestByAction.get(example.action);
    if (!existing || score > existing.score) {
      bestByAction.set(example.action, {
        action: example.action,
        score,
        margin: 0,
        matchedExample: example,
      });
    }
  }

  const candidates = [...bestByAction.values()].sort((a, b) => b.score - a.score).slice(0, 5);
  const top = candidates[0] ?? null;
  const second = candidates[1] ?? null;
  if (top) top.margin = top.score - (second?.score ?? 0);

  const confidence = top ? Math.max(0, Math.min(1, top.score + Math.min(0.18, top.margin))) : 0;
  const noMatch = !top || top.score < 0.42 || confidence < 0.52;

  return {
    candidates,
    top,
    confidence,
    noMatch,
  };
}

export function buildIntentJudgeContext(route: SemanticIntentRoute): string {
  if (!route.top) return "语义样例路由：无可用候选。";
  const lines = route.candidates.map((candidate) => {
    return [
      `- ${candidate.action}`,
      `score=${candidate.score.toFixed(2)}`,
      `margin=${candidate.margin.toFixed(2)}`,
      `example="${candidate.matchedExample.text}"`,
      `why=${candidate.matchedExample.explanation}`,
    ].join(" | ");
  });
  return [
    "语义样例路由（供裁判参考，不是最终决定）：",
    `noMatch=${route.noMatch}`,
    `confidence=${route.confidence.toFixed(2)}`,
    ...lines,
  ].join("\n");
}
