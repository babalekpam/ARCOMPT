import type { ReactNode } from "react";

export function EmptyState({ title, body, action, icon = "○" }: { title: string; body?: string; action?: ReactNode; icon?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 px-6 py-10 text-center dark:border-slate-700">
      <div className="mb-2 text-2xl text-slate-400" aria-hidden>
        {icon}
      </div>
      <p className="font-medium">{title}</p>
      {body ? <p className="mt-1 max-w-md text-sm text-slate-500">{body}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
