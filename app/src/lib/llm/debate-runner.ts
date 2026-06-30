// v0.8 阶段5 — 对弈引擎的真实 LLM 执行器
//
// 把 debate-engine 的可注入 RunRole 接到实际模型调用（Vercel AI SDK generateText）+ 落 UsageEvent。
// 用 generateText（非流式）：对弈每个角色是一次性产出，不需要流式中间态。

import { generateText } from "ai";
import { getLanguageModel } from "./provider-factory";
import { resolveMaxOutputTokens } from "./model-limits";
import { recordUsageEvent } from "./usage-tracker";
import { isCliProviderType } from "./cli-protocol";
import { streamViaCli } from "./cli-engine";
import type { RunRole } from "./debate-engine";

/** 生产用 RunRole：调真实模型 + 记录用量（role 记成 debate_<角色>，StatsPage 可见对弈成本） */
export const realRunRole: RunRole = async ({ systemPrompt, userPrompt, config, signal }) => {
  let content = "";
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    if (isCliProviderType(config.providerType)) {
      // CLI 引擎路径：把 system+user 合并成一段对话喂给本机 CLI
      const cli = await streamViaCli(
        {
          providerType: config.providerType,
          modelName: config.modelName,
          ...(config.baseUrl ? { program: config.baseUrl } : {}),
          ...(config.workingDirectory ? { workingDirectory: config.workingDirectory } : {}),
        },
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        { onDelta: (d) => { content += d; } },
        { signal },
      );
      inputTokens = cli.inputTokens;
      outputTokens = cli.outputTokens;
    } else {
      const lm = getLanguageModel(config.providerType, config.modelName, config.apiKey, config.baseUrl);
      // 按 models.dev 该模型真实输出上限给足预算，避免推理型模型把额度耗在思考、正文被截断
      const res = await generateText({
        model: lm,
        system: systemPrompt,
        prompt: userPrompt,
        maxOutputTokens: resolveMaxOutputTokens(config.modelName),
        abortSignal: signal,
      });
      content = res.text;
      inputTokens = res.usage?.inputTokens ?? 0;
      outputTokens = res.usage?.outputTokens ?? 0;
    }
  } catch (err) {
    // 用户中止：原样抛，让上层按"已停止"处理，不污染成模型错误。
    if ((err as { name?: string })?.name === "AbortError" || signal?.aborted) throw err;
    // 其余失败：带上「哪个模型 / 哪个角色 / 原因」再抛——否则博弈只剩一句 "Load failed"，无从排查。
    const reason = err instanceof Error ? err.message : String(err);
    const tagged = new Error(`模型「${config.modelName}」（${config.role}）调用失败：${reason}`);
    (tagged as { cause?: unknown }).cause = err;
    throw tagged;
  }

  void recordUsageEvent({
    modelId: config.modelId,
    modelName: config.modelName,
    providerType: config.providerType,
    providerId: config.providerId,
    apiCredentialId: config.apiCredentialId,
    role: `debate_${config.role}`,
    usage: { inputTokens, outputTokens },
    finishReason: "stop",
  });

  return { content, inputTokens, outputTokens };
};
