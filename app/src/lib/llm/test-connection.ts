// 测试连接：用户填完 API Key 后点"测试连接"按钮
import { generateText } from "ai";
import { getLanguageModel } from "./provider-factory";
import { classifyLlmError, type ClassifiedLlmError } from "./error-classifier";

export interface TestConnectionParams {
  providerType: string;
  modelName: string;
  apiKey: string;
  baseUrl?: string;
}

export interface TestConnectionResult {
  success: boolean;
  latencyMs?: number;
  modelResponse?: string;
  error?: ClassifiedLlmError;
}

export async function testConnection(
  params: TestConnectionParams,
): Promise<TestConnectionResult> {
  const start = Date.now();
  try {
    const languageModel = getLanguageModel(
      params.providerType,
      params.modelName,
      params.apiKey,
      params.baseUrl,
    );

    const result = await generateText({
      model: languageModel,
      prompt: "ping",
      maxOutputTokens: 10,
      abortSignal: AbortSignal.timeout(10_000),
    });

    return {
      success: true,
      latencyMs: Date.now() - start,
      modelResponse: result.text.slice(0, 100),
    };
  } catch (error) {
    return {
      success: false,
      latencyMs: Date.now() - start,
      error: classifyLlmError(error),
    };
  }
}
