"use client";
import { useEffect, useRef, useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Button } from "@/components/ui/Button";
import { Input, inputClass, Select } from "@/components/ui/Field";
import type { Partner, PartnerType } from "./types";

/**
 * Sélecteur de tiers avec recherche (GET /v1/partners?type=&q=) et création
 * rapide (POST /v1/partners). La valeur est le tiers entier : l'appelant en
 * garde l'identifiant pour le document et le nom pour l'affichage.
 */
export function PartnerPicker({ types, value, onChange, disabled = false }: { types: PartnerType[]; value: Partner | null; onChange: (p: Partner | null) => void; disabled?: boolean }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Partner[] | null>(null);
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
    if (!open) return;
    const handle = setTimeout(() => {
      const list = typesKey.split(",").filter(Boolean) as PartnerType[];
      const fetchAll = list.length === 1 ? apiClient<{ partners: Partner[] }>("/partners", { query: { type: list[0], q: query.trim() || undefined, limit: 30 } }).then((d) => d.partners) : apiClient<{ partners: Partner[] }>("/partners", { query: { q: query.trim() || undefined, limit: 100 } }).then((d) => d.partners.filter((p) => list.length === 0 || list.includes(p.type)));
      fetchAll
        .then((rows) => {
          setResults(rows.slice(0, 30));
          setError(null);
        })
        .catch((e) => {
          setResults([]);
          setError(errorMessage(e));
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
      const p = await apiClient<Partner>("/partners", { method: "POST", body: { type: draft.type, name: draft.name.trim(), ...(draft.taxId.trim() ? { taxId: draft.taxId.trim() } : {}), contact } });
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
              <ul role="listbox" className="max-h-56 overflow-auto">
                {results === null ? <li className="px-3 py-2 text-xs text-slate-500">{t("common.loading")}</li> : null}
                {results && results.length === 0 ? <li className="px-3 py-2 text-xs text-slate-500">{t("invoicing.partner.none")}</li> : null}
                {(results ?? []).map((p) => (
                  <li key={p.id} role="option" aria-selected={false} onMouseDown={() => { onChange(p); setOpen(false); }} className="flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800">
                    <span className="truncate">{p.name}</span>
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
