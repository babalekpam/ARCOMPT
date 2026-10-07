"use client";
import { useEffect, useState } from "react"; import { apiClient, proxyUrl } from "@/lib/api-client";
type Profile = { name: string; address: string | null; city: string | null; phone: string | null; logoDataUri: string | null };
export function CompanyProfileForm() {
  const [p, setP] = useState<Profile | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { apiClient("/company/profile").then((j) => { const v = j as { profile?: Profile }; if (v.profile) setP(v.profile); }).catch(() => {}); }, []);
  async function save() { setBusy(true); setMsg(""); try { await apiClient("/company/profile", { method: "PATCH", body: { name: p?.name, address: p?.address ?? "", city: p?.city ?? "", phone: p?.phone ?? "" } }); setMsg("Enregistre."); } finally { setBusy(false); } }
  async function up(f: File) { setBusy(true); setMsg(""); try { const fd = new FormData(); fd.append("file", f); const r = await fetch(proxyUrl("/company/logo"), { method: "POST", body: fd }); const j = await r.json().catch(() => ({})); if (r.ok && j.logoDataUri) setP((x) => (x ? { ...x, logoDataUri: j.logoDataUri } : x)); setMsg(r.ok ? "Logo mis a jour." : (j.error || "Erreur logo.")); } finally { setBusy(false); } }
  if (!p) return <p className="text-sm text-slate-500">Chargement...</p>;
  return (
    <div className="space-y-3 text-sm">
      <h3 className="font-medium">Profil de l entreprise</h3>
      <p className="text-xs text-slate-500">Ces informations apparaissent sur vos factures.</p>
      {p.logoDataUri ? <img src={p.logoDataUri} alt="Logo" className="h-12 object-contain" /> : null}
      <label className="block">Logo de l entreprise <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => { const f = e.target.files?.[0]; if (f) void up(f); }} /></label>
      <label className="block">Nom de l entreprise <input className="w-full border p-1" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></label>
      <label className="block">Adresse <input className="w-full border p-1" value={p.address ?? ""} onChange={(e) => setP({ ...p, address: e.target.value })} /></label>
      <label className="block">Ville <input className="w-full border p-1" value={p.city ?? ""} onChange={(e) => setP({ ...p, city: e.target.value })} /></label>
      <label className="block">Telephone <input className="w-full border p-1" value={p.phone ?? ""} onChange={(e) => setP({ ...p, phone: e.target.value })} /></label>
      <button disabled={busy} onClick={() => void save()} className="border px-3 py-1">Enregistrer</button>
      {msg ? <p className="text-xs">{msg}</p> : null}
    </div>
  );
}
