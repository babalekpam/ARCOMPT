"use client";
/**
 * Centre de synchronisation (docs/OFFLINE.md).
 *
 * Une file d'attente invisible est une file dans laquelle on perd des choses.
 * Cet écran montre trois états distincts, parce qu'ils appellent trois gestes
 * différents :
 *
 *   - EN ATTENTE D'ENVOI : rien à faire, le réseau manque ;
 *   - EN ATTENTE D'UN AUTRE ÉLÉMENT : la saisie désigne un objet créé hors
 *     ligne qui n'est pas encore parvenu au serveur ; elle partira seule ;
 *   - REFUSÉ : le serveur a dit non pour une raison métier. Celui-là ne partira
 *     jamais tout seul, et c'est le seul qui demande une décision humaine.
 *
 * L'écran est entièrement client : il doit s'ouvrir sans serveur.
 */
import { useCallback, useEffect, useState } from "react";
import { useLocale, useT } from "@/lib/i18n-client";
import { formatDate, type Locale } from "@/lib/i18n";
import { getOfflineServices } from "@/lib/offline-browser";
import { OPERATION_ROUTES, type OperationKind, type QueuedOperation } from "@/lib/offline-queue";
import { SNAPSHOT_KEYS, type SnapshotKey } from "@/lib/offline-snapshot";
import { notifySyncChanged, refreshSnapshots, syncNow, SYNC_EVENT } from "@/lib/offline-sync";
import type { QueuedDraft } from "@/lib/offline";

interface Row {
  clientId: string;
  kind: OperationKind;
  createdAt: string;
  attempts: number;
  lastError?: string;
  waiting?: boolean;
  summary: string;
  /** Les brouillons d'écriture vivent dans l'autre file : le retrait ne passe pas par le même appel. */
  legacy?: boolean;
}

/** Résumé d'une ligne : ce que l'utilisateur reconnaîtra de sa propre saisie. */
function summarize(kind: OperationKind, input: Record<string, unknown> | undefined): string {
  if (!input) return "—";
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    return null;
  };
  switch (kind) {
    case "entry.draft":
      return [pick("journalCode"), pick("label"), pick("date")].filter(Boolean).join(" · ") || "—";
    case "partner.create":
      return pick("name") ?? "—";
    case "product.create":
    case "stock.article":
      return [pick("code"), pick("label")].filter(Boolean).join(" · ") || "—";
    case "sales.draft":
    case "purchase.draft":
      return [pick("kind"), pick("issueDate"), pick("reference")].filter(Boolean).join(" · ") || "—";
    case "stock.movement":
      return [pick("kind"), pick("quantity"), pick("date")].filter(Boolean).join(" · ") || "—";
    case "stock.count":
      return [pick("label"), pick("date")].filter(Boolean).join(" · ") || "—";
    default:
      return pick("filename", "label", "reference") ?? "—";
  }
}

export function SyncCenter() {
  const t = useT();
  const locale = useLocale() as Locale;
  const [rows, setRows] = useState<Row[]>([]);
  const [ages, setAges] = useState<Array<{ key: SnapshotKey; fetchedAt: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [packCode, setPackCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const svc = await getOfflineServices();
    if (!svc) return;
    const [drafts, ops, snapshotAges] = await Promise.all([svc.queue.list(), svc.operations.list(), svc.snapshots.ages()]);
    const fromDrafts: Row[] = drafts.map((d: QueuedDraft) => ({
      clientId: d.clientId,
      kind: "entry.draft" as const,
      createdAt: d.createdAt,
      attempts: d.attempts,
      ...(d.lastError ? { lastError: d.lastError } : {}),
      summary: summarize("entry.draft", d.input as Record<string, unknown> | undefined),
      legacy: true,
    }));
    const fromOps: Row[] = ops.map((o: QueuedOperation) => ({
      clientId: o.clientId,
      kind: o.kind,
      createdAt: o.createdAt,
      attempts: o.attempts,
      ...(o.lastError ? { lastError: o.lastError } : {}),
      ...(o.waiting ? { waiting: o.waiting } : {}),
      summary: summarize(o.kind, o.input),
    }));
    setRows([...fromDrafts, ...fromOps].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    setAges(snapshotAges.map((a) => ({ key: a.key, fetchedAt: a.fetchedAt })));
    // Le code du pack vient du cliché : hors ligne, il n'y a rien d'autre pour le connaître.
    const pack = await svc.snapshots.read<{ code?: string }>("pack");
    setPackCode(pack?.data?.code ?? null);
  }, []);

  useEffect(() => {
    void load();
    const changed = () => void load();
    window.addEventListener(SYNC_EVENT, changed);
    return () => window.removeEventListener(SYNC_EVENT, changed);
  }, [load]);

  const runSync = useCallback(async () => {
    setBusy(true);
    try {
      const report = await syncNow();
      setNotice(report.blocked.length > 0 ? t("offline.syncError", { message: report.blocked[0]!.message }) : t("offline.synced"));
      notifySyncChanged();
    } finally {
      setBusy(false);
      await load();
    }
  }, [load, t]);

  const runRefresh = useCallback(async () => {
    if (!packCode) return;
    setBusy(true);
    try {
      await refreshSnapshots({ packCode });
    } finally {
      setBusy(false);
      await load();
    }
  }, [load, packCode]);

  const discard = useCallback(
    async (row: Row) => {
      if (!window.confirm(t("offline.center.discardConfirm"))) return;
      const svc = await getOfflineServices();
      if (!svc) return;
      if (row.legacy) await svc.queue.remove(row.clientId);
      else await svc.operations.remove(row.clientId);
      notifySyncChanged();
      await load();
    },
    [load, t],
  );

  const retry = useCallback(
    async (row: Row) => {
      const svc = await getOfflineServices();
      if (!svc || row.legacy) return void runSync();
      await svc.operations.retry(row.clientId);
      await runSync();
    },
    [runSync],
  );

  const blocked = rows.filter((r) => r.lastError && !r.waiting);
  const waiting = rows.filter((r) => r.waiting);
  const queued = rows.filter((r) => !r.lastError);

  return (
    <div className="space-y-8">
      {notice ? <p className="rounded border border-slate-300 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900">{notice}</p> : null}

      {rows.length === 0 ? <p className="text-sm text-slate-600 dark:text-slate-400">{t("offline.center.nothing")}</p> : null}

      <Section title={t("offline.center.queue")} rows={queued} t={t} locale={locale} onDiscard={discard} />
      <Section title={t("offline.center.waiting")} help={t("offline.center.waitingHelp")} rows={waiting} t={t} locale={locale} onDiscard={discard} />
      <Section title={t("offline.center.blocked")} help={t("offline.center.blockedHelp")} rows={blocked} t={t} locale={locale} onDiscard={discard} onRetry={retry} tone="error" />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t("offline.center.snapshots")}</h2>
        <p className="text-xs text-slate-600 dark:text-slate-400">{t("offline.center.snapshotsHelp")}</p>
        <ul className="divide-y divide-slate-200 rounded border border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-800">
          {SNAPSHOT_KEYS.map((key) => {
            const age = ages.find((a) => a.key === key);
            return (
              <li key={key} className="flex items-center justify-between px-3 py-2">
                <span>{t(`offline.snapshot.${key}`)}</span>
                <span className="text-xs text-slate-500">{age ? t("offline.center.refreshed", { when: formatDate(locale, age.fetchedAt) }) : t("offline.center.never")}</span>
              </li>
            );
          })}
        </ul>
        <div className="flex gap-2">
          <button type="button" onClick={() => void runSync()} disabled={busy} className="rounded border border-slate-300 px-3 py-1 text-sm dark:border-slate-700">
            {t("offline.syncNow")}
          </button>
          <button type="button" onClick={() => void runRefresh()} disabled={busy || !packCode} className="rounded border border-slate-300 px-3 py-1 text-sm dark:border-slate-700">
            {t("offline.center.refreshNow")}
          </button>
        </div>
      </section>

      <section className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        <h2 className="text-sm font-semibold">{t("offline.center.limits")}</h2>
        <p>{t("offline.center.limitsBody")}</p>
      </section>
    </div>
  );
}

function Section(props: {
  title: string;
  help?: string;
  rows: Row[];
  t: ReturnType<typeof useT>;
  locale: Locale;
  tone?: "error";
  onDiscard: (row: Row) => void | Promise<void>;
  onRetry?: (row: Row) => void | Promise<void>;
}) {
  if (props.rows.length === 0) return null;
  const { t } = props;
  return (
    <section className="space-y-2">
      <h2 className={`text-sm font-semibold ${props.tone === "error" ? "text-red-700 dark:text-red-300" : ""}`}>
        {props.title} ({props.rows.length})
      </h2>
      {props.help ? <p className="text-xs text-slate-600 dark:text-slate-400">{props.help}</p> : null}
      <ul className="divide-y divide-slate-200 rounded border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {props.rows.map((row) => (
          <li key={row.clientId} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 text-sm">
            <div className="min-w-0">
              <p className="font-medium">{t(`offline.kind.${row.kind}`) || OPERATION_ROUTES[row.kind]?.label}</p>
              <p className="truncate text-xs text-slate-600 dark:text-slate-400">{row.summary}</p>
              <p className="text-xs text-slate-500">
                {formatDate(props.locale, row.createdAt)}
                {row.attempts > 0 ? ` · ${t("offline.center.attempts", { count: row.attempts })}` : ""}
              </p>
              {row.lastError ? <p className="mt-1 text-xs text-red-700 dark:text-red-300">{row.lastError}</p> : null}
            </div>
            <div className="flex shrink-0 gap-2">
              {props.onRetry ? (
                <button type="button" onClick={() => void props.onRetry?.(row)} className="rounded border border-slate-300 px-2 py-0.5 text-xs dark:border-slate-700">
                  {t("offline.center.retry")}
                </button>
              ) : null}
              <button type="button" onClick={() => void props.onDiscard(row)} className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-700 dark:border-red-800 dark:text-red-300">
                {t("offline.center.discard")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
