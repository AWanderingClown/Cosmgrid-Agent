// 首次启动引导（v0.5 / 7.11）
// 4 步引导帮小白用户在 5 分钟内走完"加 API → 看模板 → 建项目"全流程
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
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { KeyRound, LayoutTemplate, FolderKanban, Sparkles, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "cosmgrid_onboarded_v1";

interface OnboardingModalProps {
  /** 当前 db 里的 provider 数量（0 = 还没配置任何） */
  providerCount: number;
  /** 跳到对应页 */
  onNavigate: (page: "providers" | "templates" | "projects") => void;
}

const STEPS = [
  {
    icon: KeyRound,
    title: "添加第一个 API Key",
    desc: "去「API 接入」选一个供应商（Anthropic / OpenAI / Google / OpenAI 兼容的 GLM/DeepSeek/Qwen），填上 API Key 和第一个模型。",
  },
  {
    icon: Sparkles,
    title: "再添加一个模型（推荐）",
    desc: "至少 2 个模型才能体现「多 AI 协作」——主对话用 Opus、写代码用 Gemini、测试用 Haiku 这种组合。",
  },
  {
    icon: LayoutTemplate,
    title: "看看 4 个内置模板",
    desc: "全栈 Web / 数据科学 / 移动 App / 小型脚本——每个模板都自动给角色配好最优模型。",
  },
  {
    icon: FolderKanban,
    title: "创建第一个项目",
    desc: "挑个模板，填项目名 + 工作空间路径（可以以后改），点创建就完事。",
  },
];

export function OnboardingModal({ providerCount, onNavigate }: OnboardingModalProps) {
  // 触发判断：首次（无标记）+ 没 provider → 显示
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
      // 跳到当前 step 对应的页
      const target = ["providers", "providers", "templates", "projects"][step];
      onNavigate(target as "providers" | "templates" | "projects");
    }
  }

  if (!open) return null;

  const currentStep = STEPS[step]!;
  const Icon = currentStep.icon;
  const isLast = step === STEPS.length - 1;

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
          <Sparkles className="w-3.5 h-3.5" /> 首次启动引导
        </div>

        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <Icon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">
              第 {step + 1} 步 / 共 {STEPS.length} 步：{currentStep.title}
            </h2>
          </div>
        </div>

        <p className="text-sm text-muted-foreground leading-relaxed">{currentStep.desc}</p>

        {/* 进度条 */}
        <div className="flex gap-1.5">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={cn(
                "h-1 flex-1 rounded-full transition-colors",
                i <= step ? "bg-primary" : "bg-muted",
              )}
            />
          ))}
        </div>

        <div className="flex justify-between pt-2">
          <Button
            variant="ghost"
            onClick={() => close("skip")}
            title="下次不再弹"
          >
            跳过引导
          </Button>
          <div className="flex gap-2">
            {step > 0 && (
              <Button variant="outline" onClick={() => setStep(step - 1)}>
                上一步
              </Button>
            )}
            {isLast ? (
              <Button onClick={() => close("finish")}>
                <CheckCircle2 className="w-4 h-4 mr-1" />
                我懂了，开始用
              </Button>
            ) : (
              <Button onClick={() => close("jump")}>
                下一步（跳到 {currentStep.title.includes("API") ? "API 接入" : currentStep.title.includes("模板") ? "模板" : "项目"}）
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
