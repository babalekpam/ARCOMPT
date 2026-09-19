"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import type { AssistantAnswer } from "@/components/documents/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { inputClass } from "@/components/ui/Field";
import { nextMessageId, normalizeQuestion, splitAnswer, SUGGESTED_QUESTIONS, type ChatMessage } from "./helpers";

/**
 * Assistant conversationnel : une question → un outil de lecture typé côté
 * serveur → une réponse toujours suivie de « Ne remplace pas l'expert-comptable ».
 * L'historique vit dans l'état du composant uniquement (rien n'est persisté).
 */
export function AssistantChat() {
  const t = useT();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, busy]);

  const ask = async (raw: string) => {
    const question = normalizeQuestion(raw);
    if (!question || busy) return;
    setInput("");
    setMessages((m) => [...m, { id: nextMessageId(), role: "user", text: question, at: new Date().toISOString() }]);
    setBusy(true);
    try {
      const r = await apiClient<AssistantAnswer>("/assistant/ask", { method: "POST", body: { question } });
      setMessages((m) => [...m, { id: nextMessageId(), role: "assistant", text: r.answer, tool: r.tool, arguments: r.arguments, data: r.data, at: new Date().toISOString() }]);
    } catch (e) {
      setMessages((m) => [...m, { id: nextMessageId(), role: "error", text: errorMessage(e), at: new Date().toISOString() }]);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(input);
  };

  return (
    <div className="flex min-h-[60vh] flex-col rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
        {messages.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-2xl" aria-hidden>◎</p>
            <p className="mt-2 font-medium">{t("assistant.empty")}</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">{t("assistant.disclaimer")}</p>
          </div>
        ) : null}
        {messages.map((m) => {
          if (m.role === "user") {
            return (
              <div key={m.id} className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-slate-900 px-3 py-2 text-sm text-white dark:bg-slate-100 dark:text-slate-900">{m.text}</p>
              </div>
            );
          }
          if (m.role === "error") {
            return (
              <div key={m.id} className="flex">
                <p className="max-w-[85%] rounded-2xl rounded-bl-sm border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">{m.text}</p>
              </div>
            );
          }
          const { body, footer } = splitAnswer(m.text);
          return (
            <div key={m.id} className="flex">
              <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800">
                <p className="whitespace-pre-wrap">{body}</p>
                <p className="mt-2 border-t border-slate-200 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:border-slate-700">{footer}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  {m.tool ? (
                    <span className="flex items-center gap-1 text-slate-500">
                      {t("assistant.tool")} <Badge tone="info">{t(`assistant.tools.${m.tool}`)}</Badge> <span className="font-mono text-[10px]">{m.tool}</span>
                    </span>
                  ) : null}
                  {m.data !== undefined && m.data !== null ? (
                    <details className="w-full">
                      <summary className="cursor-pointer text-slate-500">{t("assistant.data")}</summary>
                      <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-slate-900 p-2 text-[11px] text-slate-100">{JSON.stringify({ arguments: m.arguments, data: m.data }, null, 2)}</pre>
                    </details>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
        {busy ? <p className="text-xs text-slate-500">{t("assistant.thinking")}</p> : null}
        <div ref={endRef} />
      </div>
      <div className="border-t border-slate-200 p-3 dark:border-slate-800">
        <p className="mb-2 text-xs text-slate-500">{t("assistant.suggested")}</p>
        <div className="mb-3 flex flex-wrap gap-2">
          {SUGGESTED_QUESTIONS.map((q) => (
            <button key={q} type="button" onClick={() => void ask(q)} disabled={busy} className="rounded-full border border-slate-300 px-3 py-1 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800">
              {q}
            </button>
          ))}
        </div>
        <form onSubmit={submit} className="flex gap-2">
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t("assistant.placeholder")} aria-label={t("assistant.placeholder")} maxLength={2000} className={inputClass} autoComplete="off" />
          <Button type="submit" disabled={busy || normalizeQuestion(input) === null}>{busy ? t("common.loading") : t("assistant.ask")}</Button>
          {messages.length > 0 ? (
            <Button variant="ghost" onClick={() => setMessages([])} disabled={busy}>{t("assistant.clear")}</Button>
          ) : null}
        </form>
      </div>
    </div>
  );
}
