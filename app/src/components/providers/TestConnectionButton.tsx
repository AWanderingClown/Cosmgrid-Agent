// 测试连接按钮
// v0.3：直接调 src/lib/llm/test-connection.ts（不走后端 HTTP）
// v0.7：error.userMessage 走 i18n（传 t 函数给 classifyLlmError）
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Loader2, XCircle, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { testConnection, type TestConnectionResult } from "@/lib/llm/test-connection";
import { classifyLlmError } from "@/lib/llm/error-classifier";

interface Props {
  providerType: string;
  modelName: string;
  apiKey: string;
  baseUrl?: string;
  disabled?: boolean;
}

const DEBOUNCE_MS = 2000;

export function TestConnectionButton({
  providerType,
  modelName,
  apiKey,
  baseUrl,
  disabled,
}: Props) {
  const { t } = useTranslation();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestConnectionResult | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const canTest =
    !disabled && !testing && Boolean(providerType) && Boolean(modelName) && Boolean(apiKey);

  async function handleClick() {
    if (!canTest) return;
    setTesting(true);
    setResult(null);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    try {
      const data = await testConnection({ providerType, modelName, apiKey, baseUrl, t });
      setResult(data);
    } catch (err) {
      const classified = classifyLlmError(err, t);
      setResult({
        success: false,
        error: {
          category: classified.category,
          httpStatus: classified.httpStatus,
          userMessage: classified.userMessage,
          technicalMessage: classified.technicalMessage,
          shouldFallback: classified.shouldFallback,
        },
      });
    } finally {
      timerRef.current = setTimeout(() => setTesting(false), DEBOUNCE_MS);
    }
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        onClick={handleClick}
        disabled={!canTest}
      >
        {testing ? (
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        ) : (
          <Zap className="w-4 h-4 mr-2" />
        )}
        {testing ? t("addProvider.testing") : t("addProvider.testConnection")}
      </Button>
      {result && (
        <Alert variant={result.success ? "default" : "destructive"}>
          <div className="flex items-center gap-2">
            {result.success ? (
              <>
                <CheckCircle2 className="w-4 h-4 text-green-500" />
                <AlertDescription>
                  {result.latencyMs
                    ? t("addProvider.connectSuccessWithLatency", { ms: result.latencyMs })
                    : t("addProvider.connectSuccess")}
                  {result.modelResponse ? `: ${result.modelResponse}` : ""}
                </AlertDescription>
              </>
            ) : (
              <>
                <XCircle className="w-4 h-4" />
                <AlertDescription>
                  {t("addProvider.connectFailed", { error: result.error?.userMessage ?? t("addProvider.unknownError") })}
                </AlertDescription>
              </>
            )}
          </div>
        </Alert>
      )}
    </div>
  );
}
