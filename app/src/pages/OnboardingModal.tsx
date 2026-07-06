// 首次启动引导（v0.5 / 7.11）
// 4 步引导帮用户在 5 分钟内走完"加 API → 看模板 → 回到对话绑定工作文件夹"全流程
//
// 设计原则（沿用 v0.4 全自动模型分配 / AI 自动生成检查点 的减负思路）：
// 1. 系统能判断的就自动做（用 useEffect 自动检测有无 provider，决定是否弹窗）
// 2. 用户可一键关掉，标记 "已引导" 不再弹
// 3. 每一步的"下一步"按钮直接跳到对应页面，不卡用户
//
// 触发条件：
// - localStorage 没 "cosmgrid_onboarded_v1" 标记
// - db 里没有 enabled 的 provider
// 满足任一就关掉（db 有 provider 视为"已经会用了"，不再骚扰）

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { KeyRound, LayoutTemplate, MessageSquare, Sparkles, CheckCircle2 } from "lucide-react";

const STORAGE_KEY = "cosmgrid_onboarded_v1";

interface OnboardingModalProps {
  /** 当前 db 里的 provider 数量（0 = 还没配置任何） */
  providerCount: number;
  /** 跳到对应页 */
  onNavigate: (page: "providers" | "templates" | "chat") => void;
}

const STEP_ICONS = [KeyRound, Sparkles, LayoutTemplate, MessageSquare];
const STEP_KEYS = ["addApiKey", "addSecondModel", "browseTemplates", "bindWorkspace"] as const;
const STEP_TARGETS: Array<"providers" | "templates" | "chat"> = [
  "providers",
  "providers",
  "templates",
  "chat",
];

export function OnboardingModal({ providerCount, onNavigate }: OnboardingModalProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    const dismissed = localStorage.getItem(STORAGE_KEY) === "1";
    if (dismissed) return;
    if (providerCount > 0) {
      // 已经有 provider 了，标记已引导不再弹
      localStorage.setItem(STORAGE_KEY, "1");
      return;
    }
    setOpen(true);
  }, [providerCount]);

  function close(reason: "skip" | "finish" | "jump") {
    localStorage.setItem(STORAGE_KEY, "1");
    setOpen(false);
    if (reason === "jump") {
      onNavigate(STEP_TARGETS[step]!);
    }
  }

  if (!open) return null;

  const Icon = STEP_ICONS[step]!;
  const stepKey = STEP_KEYS[step]!;
  const isLast = step === STEP_KEYS.length - 1;

  // 下一步按钮的"跳到 X"标签：根据 step 选目标页名
  const nextTargetLabel = t(
    `onboarding.nextTarget.${STEP_TARGETS[step]!}`,
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6"
      onClick={() => close("skip")}
    >
      <Card
        className="w-full max-w-lg p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Sparkles className="w-3.5 h-3.5" /> {t("onboarding.title")}
        </div>

        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <Icon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">
              {t("onboarding.stepOf", {
                current: step + 1,
                total: STEP_KEYS.length,
                stepTitle: t(`onboarding.steps.${stepKey}.title`),
              })}
            </h2>
          </div>
        </div>

        <p className="text-sm text-muted-foreground leading-relaxed">
          {t(`onboarding.steps.${stepKey}.desc`)}
        </p>

        {/* 进度条 */}
        <div className="flex gap-1.5">
          {STEP_KEYS.map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i <= step ? "bg-primary" : "bg-muted"
              }`}
            />
          ))}
        </div>

        <div className="flex justify-between pt-2">
          <Button
            variant="ghost"
            onClick={() => close("skip")}
            title={t("onboarding.neverShow")}
          >
            {t("onboarding.skip")}
          </Button>
          <div className="flex gap-2">
            {step > 0 && (
              <Button variant="outline" onClick={() => setStep(step - 1)}>
                {t("onboarding.prev")}
              </Button>
            )}
            {isLast ? (
              <Button onClick={() => close("finish")}>
                <CheckCircle2 className="w-4 h-4 mr-1" />
                {t("onboarding.done")}
              </Button>
            ) : (
              <Button onClick={() => close("jump")}>
                {t("onboarding.nextWithTarget", { target: nextTargetLabel })}
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
