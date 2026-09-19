"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { useT } from "@/lib/i18n-client";
import { Button, type ButtonVariant } from "./Button";

/** Boîte de confirmation accessible (élément <dialog> natif). */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  confirmVariant = "primary",
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  confirmVariant?: ButtonVariant;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onCancel} className="w-[min(92vw,28rem)] rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-900/40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
      <form method="dialog" className="p-5" onSubmit={(e) => e.preventDefault()}>
        <h3 className="text-base font-semibold">{title}</h3>
        {children ? <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">{children}</div> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant={confirmVariant} onClick={onConfirm} disabled={busy}>
            {busy ? t("common.loading") : (confirmLabel ?? t("common.confirm"))}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
