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
export const realRunRole: RunRole = async ({ systemPrompt, userPrompt, config }) => {
  let content = "";
  let inputTokens = 0;
  let outputTokens = 0;

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
      {},
    );
    inputTokens = cli.inputTokens;
    outputTokens = cli.outputTokens;
  } else {
    const lm = getLanguageModel(config.providerType, config.modelName, config.apiKey, config.baseUrl);
    // 按 models.dev 该模型真实输出上限给足预算，避免推理型模型把额度耗在思考、正文被截断
    const res = await generateText({ model: lm, system: systemPrompt, prompt: userPrompt, maxOutputTokens: resolveMaxOutputTokens(config.modelName) });
    content = res.text;
    inputTokens = res.usage?.inputTokens ?? 0;
    outputTokens = res.usage?.outputTokens ?? 0;
  }

  void recordUsageEvent({
    modelId: config.modelId,
    modelName: config.modelName,
    providerId: config.providerId,
    apiCredentialId: config.apiCredentialId,
    role: `debate_${config.role}`,
    usage: { inputTokens, outputTokens },
    finishReason: "stop",
  });

  return { content, inputTokens, outputTokens };
};
