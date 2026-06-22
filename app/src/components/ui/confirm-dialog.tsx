// 应用内确认 / 提示弹窗（替代 window.confirm / window.alert）
// 为什么需要：Tauri 的 WKWebView 不支持同步的 window.confirm()/alert()——
// confirm() 直接返回 false，导致所有 `if (!confirm(...)) return` 永远命中 return、删除永不执行。
// 这里用 Radix Dialog 做一个 Promise 化的应用内弹窗，到处可用、风格统一、不依赖原生对话框。
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface ConfirmOptions {
  title?: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（删除等）用红色确认按钮 */
  destructive?: boolean;
}

interface AlertOptions {
  title?: string;
  description: string;
  okText?: string;
}

interface ConfirmContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  alert: (opts: AlertOptions) => Promise<void>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

type DialogState =
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: "alert"; opts: AlertOptions; resolve: () => void }
  | null;

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [state, setState] = useState<DialogState>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setState({ kind: "confirm", opts, resolve })),
    [],
  );

  const alert = useCallback(
    (opts: AlertOptions) =>
      new Promise<void>((resolve) => setState({ kind: "alert", opts, resolve })),
    [],
  );

  // 关闭并回传结果（点遮罩/Esc 关闭视为取消）
  const settle = (result: boolean) => {
    setState((s) => {
      if (s) {
        if (s.kind === "confirm") s.resolve(result);
        else s.resolve();
      }
      return null;
    });
  };

  return (
    <ConfirmContext.Provider value={{ confirm, alert }}>
      {children}
      <Dialog open={state !== null} onOpenChange={(open) => { if (!open) settle(false); }}>
        {state && (
          <DialogContent showCloseButton={false} className="glass rounded-2xl max-w-sm border-white/10">
            <DialogHeader>
              <DialogTitle>
                {state.opts.title ??
                  (state.kind === "confirm" ? t("common.confirmTitle") : t("common.noticeTitle"))}
              </DialogTitle>
              <DialogDescription className="whitespace-pre-wrap break-words">
                {state.opts.description}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              {state.kind === "confirm" ? (
                <>
                  <Button variant="outline" className="rounded-xl" onClick={() => settle(false)}>
                    {state.opts.cancelText ?? t("common.cancel")}
                  </Button>
                  <Button
                    variant={state.opts.destructive ? "destructive" : "default"}
                    className="rounded-xl"
                    onClick={() => settle(true)}
                  >
                    {state.opts.confirmText ?? t("common.confirm")}
                  </Button>
                </>
              ) : (
                <Button className="rounded-xl" onClick={() => settle(true)}>
                  {state.opts.okText ?? t("common.ok")}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider");
  return ctx;
}
