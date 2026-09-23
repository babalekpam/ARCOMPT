"use client";
import { useEffect, useRef, useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { getOfflineServices } from "@/lib/offline-browser";
import { createOrQueue } from "@/lib/offline-submit";
import { Button } from "@/components/ui/Button";
import { Input, inputClass, Select } from "@/components/ui/Field";
import type { Partner, PartnerType } from "./types";

/**
 * Sélecteur de tiers avec recherche (GET /v1/partners?type=&q=) et création
 * rapide (POST /v1/partners). La valeur est le tiers entier : l'appelant en
 * garde l'identifiant pour le document et le nom pour l'affichage.
 *
 * Hors ligne (docs/OFFLINE.md) :
 *   - la recherche se rabat sur le cliché local des tiers, filtré sur
 *     l'appareil. Sans lui, saisir une facture sans réseau serait impossible :
 *     on ne peut pas facturer un client qu'on ne peut pas désigner.
 *   - la création rapide met le tiers en file et rend un tiers portant un
 *     identifiant LOCAL (`local:<uuid>`). Le document qui le désigne part avec
 *     cette référence ; le rejeu la remplace par l'identifiant serveur une fois
 *     le tiers réellement créé.
 */
export function PartnerPicker({ types, value, onChange, disabled = false }: { types: PartnerType[]; value: Partner | null; onChange: (p: Partner | null) => void; disabled?: boolean }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Partner[] | null>(null);
  /** Vrai quand la liste vient du cliché local : l'écran doit le dire. */
  const [offline, setOffline] = useState(false);
  /** Tiers créés sur cet appareil et pas encore parvenus au serveur. */
  const [local, setLocal] = useState<Partner[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; type: PartnerType; taxId: string; phone: string; email: string }>({ name: "", type: types[0] ?? "CUSTOMER", taxId: "", phone: "", email: "" });
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const typesKey = types.join(",");

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => {
    void (async () => {
      const svc = await getOfflineServices();
      if (!svc) return;
      const pending = await svc.operations.list();
      setLocal(
        pending
          .filter((o) => o.kind === "partner.create" && o.produces && o.input)
          .map((o) => {
            const input = o.input as { type?: PartnerType; name?: string; taxId?: string; contact?: Record<string, string> };
            return {
              id: o.produces!,
              type: input.type ?? "CUSTOMER",
              name: input.name ?? "",
              taxId: input.taxId ?? null,
              collectiveAccount: "",
              contact: input.contact ?? {},
              active: true,
              createdAt: o.createdAt,
            } satisfies Partner;
          }),
      );
    })();
  }, []);

  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(() => {
      const list = typesKey.split(",").filter(Boolean) as PartnerType[];
      const fetchAll = list.length === 1 ? apiClient<{ partners: Partner[] }>("/partners", { query: { type: list[0], q: query.trim() || undefined, limit: 30 } }).then((d) => d.partners) : apiClient<{ partners: Partner[] }>("/partners", { query: { q: query.trim() || undefined, limit: 100 } }).then((d) => d.partners.filter((p) => list.length === 0 || list.includes(p.type)));
      fetchAll
        .then((rows) => {
          setResults(rows.slice(0, 30));
          setOffline(false);
          setError(null);
        })
        .catch((e) => {
          // Repli sur le cliché local. Le filtrage se fait ici parce qu'il n'y a
          // pas de serveur pour le faire ; il est volontairement plus simple que
          // celui de l'API (nom seulement, pas d'index aveugle sur l'identifiant
          // fiscal, que l'appareil ne sait pas calculer).
          void (async () => {
            const svc = await getOfflineServices();
            const cached = svc ? await svc.snapshots.read<{ partners: Partner[] }>("partners") : null;
            if (!cached) {
              setResults([]);
              setOffline(false);
              setError(errorMessage(e));
              return;
            }
            const needle = query.trim().toLowerCase();
            const rows = cached.data.partners
              .filter((p) => (list.length === 0 || list.includes(p.type)) && (!needle || p.name.toLowerCase().includes(needle)))
              .slice(0, 30);
            setResults([...rows, ...local.filter((p) => list.length === 0 || list.includes(p.type))]);
            setOffline(true);
            setError(null);
          })();
        });
    }, 200);
    return () => clearTimeout(handle);
  }, [query, open, typesKey]);

  const create = async () => {
    if (!draft.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const contact: Record<string, string> = {};
      if (draft.phone.trim()) contact.phone = draft.phone.trim();
      if (draft.email.trim()) contact.email = draft.email.trim();
      const input = { type: draft.type, name: draft.name.trim(), ...(draft.taxId.trim() ? { taxId: draft.taxId.trim() } : {}), contact };
      const outcome = await createOrQueue("partner.create", input, (body) => apiClient<Partner>("/partners", { method: "POST", body }), { producesLocalRef: true });
      const p: Partner = outcome.queued
        ? { id: outcome.localRef!, type: draft.type, name: draft.name.trim(), taxId: draft.taxId.trim() || null, collectiveAccount: "", contact, active: true, createdAt: new Date().toISOString() }
        : outcome.result;
      if (outcome.queued) setLocal((prev) => [...prev, p]);
      onChange(p);
      setCreating(false);
      setOpen(false);
      setDraft({ name: "", type: types[0] ?? "CUSTOMER", taxId: "", phone: "", email: "" });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800/50">
        <div className="min-w-0">
          <div className="truncate font-medium">{value.name}</div>
          <div className="text-xs text-slate-500">
            {t(`invoicing.partnerType.${value.type}`)} · {value.collectiveAccount}
            {value.taxId ? ` · ${value.taxId}` : ""}
          </div>
        </div>
        {!disabled ? (
          <Button variant="ghost" size="sm" onClick={() => onChange(null)} aria-label={t("invoicing.partner.change")}>
            {t("invoicing.partner.change")}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={t("invoicing.partner.search")}
        aria-label={t("invoicing.partner.label")}
        aria-autocomplete="list"
        aria-expanded={open}
        className={inputClass}
        autoComplete="off"
        disabled={disabled}
      />
      {open ? (
        <div className="absolute z-30 mt-1 w-[min(28rem,92vw)] rounded-lg border border-slate-200 bg-white text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {!creating ? (
            <>
              {offline ? <p className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{t("offline.partners.fromSnapshot")}</p> : null}
              <ul role="listbox" className="max-h-56 overflow-auto">
                {results === null ? <li className="px-3 py-2 text-xs text-slate-500">{t("common.loading")}</li> : null}
                {results && results.length === 0 ? <li className="px-3 py-2 text-xs text-slate-500">{t("invoicing.partner.none")}</li> : null}
                {(results ?? []).map((p) => (
                  <li key={p.id} role="option" aria-selected={false} onMouseDown={() => { onChange(p); setOpen(false); }} className="flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800">
                    <span className="truncate">
                      {p.name}
                      {p.id.startsWith("local:") ? <span className="ml-1 text-xs text-amber-700 dark:text-amber-300">· {t("offline.partners.pending")}</span> : null}
                    </span>
                    <span className="shrink-0 text-xs text-slate-500">{t(`invoicing.partnerType.${p.type}`)}</span>
                  </li>
                ))}
              </ul>
              <div className="border-t border-slate-200 p-2 dark:border-slate-700">
                <Button variant="secondary" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={() => { setCreating(true); setDraft((d) => ({ ...d, name: query })); }}>
                  + {t("invoicing.partner.create")}
                </Button>
              </div>
            </>
          ) : (
            <div className="space-y-2 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("invoicing.partner.create")}</p>
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("invoicing.partner.name")} aria-label={t("invoicing.partner.name")} maxLength={200} />
              <Select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as PartnerType })} aria-label={t("invoicing.partner.type")}>
                {(types.length > 0 ? types : (["CUSTOMER", "SUPPLIER", "EMPLOYEE", "STATE", "OTHER"] as PartnerType[])).map((x) => (
                  <option key={x} value={x}>
                    {t(`invoicing.partnerType.${x}`)}
                  </option>
                ))}
              </Select>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Input value={draft.taxId} onChange={(e) => setDraft({ ...draft, taxId: e.target.value })} placeholder={t("invoicing.partner.taxId")} aria-label={t("invoicing.partner.taxId")} maxLength={60} />
                <Input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} placeholder={t("invoicing.partner.phone")} aria-label={t("invoicing.partner.phone")} maxLength={40} />
                <Input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder={t("invoicing.partner.email")} aria-label={t("invoicing.partner.email")} maxLength={200} type="email" />
              </div>
              {error ? <p className="text-xs text-red-600">{error}</p> : null}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setCreating(false)} disabled={busy}>
                  {t("common.cancel")}
                </Button>
                <Button size="sm" onClick={() => void create()} disabled={busy || !draft.name.trim()}>
                  {busy ? t("common.loading") : t("common.save")}
                </Button>
              </div>
            </div>
          )}
          {error && !creating ? <p className="px-3 pb-2 text-xs text-red-600">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
