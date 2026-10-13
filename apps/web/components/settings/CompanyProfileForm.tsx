"use client";
import { useEffect, useRef, useState } from "react";
import { apiClient, proxyUrl } from "@/lib/api-client";
import { Card, CardTitle } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Button, buttonClass } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
type Profile = { name: string; address: string | null; city: string | null; phone: string | null; logoDataUri: string | null };
function errText(e: unknown, fallback: string): string { if (typeof e === "string" && e) return e; if (e && typeof e === "object") { const o = e as { message?: unknown; error?: unknown }; if (typeof o.message === "string" && o.message) return o.message; if (o.error && o.error !== e) return errText(o.error, fallback); } return fallback; }
export function CompanyProfileForm() {
const [p, setP] = useState<Profile | null>(null);
const [msg, setMsg] = useState("");
const [busy, setBusy] = useState(false);
const fileRef = useRef<HTMLInputElement>(null);
useEffect(() => { apiClient("/company/profile").then((j) => { const v = j as { profile?: Profile }; if (v.profile) setP(v.profile); }).catch(() => {}); }, []);
async function save() { setBusy(true); setMsg(""); try { await apiClient("/company/profile", { method: "PATCH", body: { name: p?.name, address: p?.address ?? "", city: p?.city ?? "", phone: p?.phone ?? "" } }); setMsg("Enregistré."); } catch (e) { setMsg(errText(e, "Erreur lors de l’enregistrement.")); } finally { setBusy(false); } }
async function up(f: File) { setBusy(true); setMsg(""); try { const fd = new FormData(); fd.append("file", f); const r = await fetch(proxyUrl("/company/logo"), { method: "POST", body: fd }); const j = await r.json().catch(() => ({})); if (r.ok && j.logoDataUri) setP((x) => (x ? { ...x, logoDataUri: j.logoDataUri } : x)); setMsg(r.ok ? "Logo mis à jour." : errText(j.error, "Erreur logo.")); } finally { setBusy(false); } }
async function removeLogo() { setBusy(true); setMsg(""); try { const r = await fetch(proxyUrl("/company/logo"), { method: "DELETE" }); const j = await r.json().catch(() => ({})); if (r.ok) { setP((x) => (x ? { ...x, logoDataUri: null } : x)); setMsg("Logo supprimé."); } else { setMsg(errText(j.error, "Erreur logo.")); } } finally { setBusy(false); } }
if (!p) return (<Card><p className="text-sm text-slate-500">Chargement...</p></Card>);
const isError = /erreur|error|échec/i.test(msg);
return (
<Card>
<CardTitle hint="Ces informations apparaissent sur vos factures.">Profil de l’entreprise</CardTitle>
<div className="space-y-5">
<div className="flex flex-col gap-4 sm:flex-row sm:items-center">
<div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
{p.logoDataUri ? (<img src={p.logoDataUri} alt="Logo" className="h-full w-full object-contain p-1" />) : (<span className="px-1 text-center text-[11px] leading-tight text-slate-400">Aucun logo</span>)}
</div>
<div className="min-w-0 space-y-2">
<div className="flex flex-wrap items-center gap-2">
<label htmlFor="company-logo-input" className={buttonClass("secondary", "sm") + " cursor-pointer"}>Choisir un logo</label>
<input ref={fileRef} id="company-logo-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void up(f); e.target.value = ""; }} />
{p.logoDataUri ? (<button type="button" disabled={busy} onClick={() => void removeLogo()} className={buttonClass("ghost", "sm")}>Supprimer</button>) : null}
</div>
<p className="text-xs text-slate-500">Logo de l’entreprise — PNG, JPG, WebP ou GIF, 2 Mo max.</p>
</div>
</div>
<div className="grid gap-4 sm:grid-cols-2">
<div className="sm:col-span-2"><Field label="Nom de l’entreprise"><Input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field></div>
<div className="sm:col-span-2"><Field label="Adresse"><Input value={p.address ?? ""} onChange={(e) => setP({ ...p, address: e.target.value })} /></Field></div>
<div><Field label="Ville"><Input value={p.city ?? ""} onChange={(e) => setP({ ...p, city: e.target.value })} /></Field></div>
<div><Field label="Téléphone"><Input value={p.phone ?? ""} onChange={(e) => setP({ ...p, phone: e.target.value })} /></Field></div>
</div>
{msg ? (<Alert tone={isError ? "danger" : "success"}>{msg}</Alert>) : null}
<div className="flex justify-end border-t border-slate-100 pt-4"><Button disabled={busy} onClick={() => void save()}>Enregistrer</Button></div>
</div>
</Card>
);
}
