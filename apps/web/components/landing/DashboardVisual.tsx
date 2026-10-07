import type { ReactNode } from "react";

const NAV_ITEMS = [
  { label: "Tableau de bord", active: true, path: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" },
  { label: "Écritures", active: false, path: "M6 3h9l5 5v13H6zM15 3v5h5M9 13h8M9 17h8" },
  { label: "Pièces", active: false, path: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6" },
  { label: "Grand livre", active: false, path: "M5 4h14v16H5zM9 4v16M9 9h6M9 13h6" },
  { label: "Balance", active: false, path: "M12 3v18M5 21h14M6 7l-3 6a3.5 3.5 0 0 0 6 0L6 7zm12 0l-3 6a3.5 3.5 0 0 0 6 0l-3-6zM8 7h8" },
  { label: "Contrôles", active: false, path: "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3zM9 12l2 2 4-4" },
];

const STATS = [
  { label: "Trésorerie", value: "3", detail: "Comptes banque et caisse" },
  { label: "Écritures en attente", value: "12", detail: "À contrôler" },
  { label: "Pièces à vérifier", value: "8", detail: "À rattacher" },
];

const ROWS = [
  { account: "512 · Banque", label: "Écriture de banque", status: "Validée", tone: "emerald" },
  { account: "411 · Clients", label: "Facture de vente", status: "À contrôler", tone: "navy" },
  { account: "401 · Fournisseurs", label: "Achat à justifier", status: "Pièce à vérifier", tone: "amber" },
  { account: "706 · Prestations", label: "Prestation de services", status: "Validée", tone: "emerald" },
  { account: "571 · Caisse", label: "Opération de caisse", status: "En attente", tone: "navy" },
] as const;

function Icon({ path }: { path: string }) {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px] shrink-0" aria-hidden="true"><path d={path} /></svg>);
}

function Chart() {
  return (<svg viewBox="0 0 340 190" className="h-auto w-full" aria-hidden="true"><line x1="28" y1="158" x2="322" y2="158" stroke="#0F2A43" strokeOpacity="0.16" /><line x1="28" y1="112" x2="322" y2="112" stroke="#0F2A43" strokeOpacity="0.08" /><line x1="28" y1="66" x2="322" y2="66" stroke="#0F2A43" strokeOpacity="0.08" /><g><rect x="42" y="96" width="26" height="62" rx="6" fill="#0E9F6E" /><rect x="88" y="78" width="26" height="80" rx="6" fill="#0F2A43" /><rect x="134" y="104" width="26" height="54" rx="6" fill="#0E9F6E" opacity="0.75" /><rect x="180" y="62" width="26" height="96" rx="6" fill="#0F2A43" opacity="0.88" /><rect x="226" y="86" width="26" height="72" rx="6" fill="#0E9F6E" /><rect x="272" y="52" width="26" height="106" rx="6" fill="#0F2A43" /></g><polyline points="55,88 101,70 147,92 193,54 239,74 285,42" fill="none" stroke="#0E9F6E" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /><g fill="#FFFFFF" stroke="#0E9F6E" strokeWidth="2.5"><circle cx="55" cy="88" r="4" /><circle cx="101" cy="70" r="4" /><circle cx="147" cy="92" r="4" /><circle cx="193" cy="54" r="4" /><circle cx="239" cy="74" r="4" /><circle cx="285" cy="42" r="4" /></g><g fill="#0F2A43" fillOpacity="0.55" fontFamily="Inter, system-ui, sans-serif" fontSize="10"><text x="50" y="176">Jan</text><text x="94" y="176">Fév</text><text x="138" y="176">Mar</text><text x="184" y="176">Avr</text><text x="230" y="176">Mai</text><text x="274" y="176">Juin</text></g></svg>);
}

function StatusPill({ tone, children }: { tone: string; children: ReactNode }) {
  const classes = tone === "emerald" ? "bg-[#0E9F6E]/10 text-[#0B7A55] ring-[#0E9F6E]/25" : tone === "amber" ? "bg-amber-500/10 text-amber-700 ring-amber-500/25" : "bg-[#0F2A43]/[.07] text-[#0F2A43] ring-[#0F2A43]/15";
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-1 text-[10px] font-semibold leading-none ring-1 ${classes}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{children}</span>;
}

export default function DashboardVisual() {
  return (
    <figure className="mx-auto mt-10 w-full min-w-0 max-w-6xl sm:mt-12" aria-label="Aperçu illustratif du tableau de bord ARCOMPT">
      <div className="overflow-hidden rounded-[22px] border border-[#0F2A43]/10 bg-white shadow-[0_24px_60px_rgba(15,42,67,0.16)] ring-1 ring-white/60">
        <div className="flex items-center gap-3 bg-[#0F2A43] px-4 py-3 sm:px-5">
          <div className="flex gap-1.5" aria-hidden="true"><span className="h-2.5 w-2.5 rounded-full bg-white/35" /><span className="h-2.5 w-2.5 rounded-full bg-[#0E9F6E]" /><span className="h-2.5 w-2.5 rounded-full bg-white/70" /></div>
          <div className="min-w-0 flex-1 truncate rounded-full bg-white/10 px-3 py-1.5 text-[11px] font-medium tracking-wide text-white/85">ARCOMPT · Tableau de bord</div>
          <span className="hidden shrink-0 rounded-full bg-[#0E9F6E] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-white sm:inline-flex">Aperçu</span>
        </div>
        <div className="flex min-w-0">
          <aside className="flex w-12 shrink-0 flex-col items-center bg-[#0F2A43] px-2 py-4 text-white sm:w-14 md:w-52 md:items-stretch md:p-4">
            <div className="mb-5 flex items-center gap-2.5 md:px-2"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#0E9F6E] text-sm font-black">A</span><span className="hidden text-sm font-bold tracking-[0.14em] md:block">ARCOMPT</span></div>
            <nav className="flex w-full flex-col gap-1.5" aria-hidden="true">{NAV_ITEMS.map((item) => (<span key={item.label} className={`flex items-center justify-center gap-2.5 rounded-lg px-2 py-2.5 text-[12px] font-semibold md:justify-start ${item.active ? "bg-[#0E9F6E] text-white shadow-sm" : "text-white/70"}`}><Icon path={item.path} /><span className="hidden truncate md:block">{item.label}</span></span>))}</nav>
            <div className="mt-auto hidden rounded-xl bg-white/[.07] p-3 text-[11px] leading-relaxed text-white/70 md:block"><span className="mb-1 block font-semibold text-white">SYSCOHADA</span>Grand livre et balance</div>
          </aside>
          <div className="min-w-0 flex-1 bg-[#F7F5F0] p-3 sm:p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><div><p className="text-[15px] font-bold text-[#0F2A43] sm:text-base">Tableau de bord</p><p className="text-[11px] text-[#0F2A43]/55 sm:text-xs">Vue d’ensemble de l’activité comptable</p></div><span className="rounded-full border border-[#0E9F6E]/25 bg-white px-2.5 py-1 text-[10px] font-semibold text-[#0B7A55]">Aperçu illustratif</span></div>
            <div className="grid gap-3 sm:grid-cols-3">{STATS.map((stat) => (<div key={stat.label} className="min-w-0 rounded-2xl border border-[#0F2A43]/[.08] bg-white p-3.5 shadow-[0_2px_10px_rgba(15,42,67,0.05)] sm:p-4"><p className="truncate text-[10px] font-bold uppercase tracking-[0.09em] text-[#0F2A43]/50">{stat.label}</p><p className="mt-1.5 text-[26px] font-black leading-none text-[#0F2A43]">{stat.value}</p><p className="mt-1.5 truncate text-[11px] font-medium text-[#0E9F6E]">{stat.detail}</p></div>))}</div>
            <div className="mt-3 grid min-w-0 gap-3 xl:grid-cols-5">
              <section className="min-w-0 rounded-2xl border border-[#0F2A43]/[.08] bg-white p-4 shadow-[0_2px_10px_rgba(15,42,67,0.05)] xl:col-span-2"><div className="mb-2 flex items-center justify-between gap-2"><h3 className="truncate text-[13px] font-bold text-[#0F2A43]">Écritures du mois</h3><span className="rounded-full bg-[#0E9F6E]/10 px-2 py-1 text-[10px] font-semibold text-[#0B7A55]">Suivi</span></div><Chart /></section>
              <section className="min-w-0 overflow-hidden rounded-2xl border border-[#0F2A43]/[.08] bg-white shadow-[0_2px_10px_rgba(15,42,67,0.05)] xl:col-span-3"><div className="flex items-center justify-between gap-2 px-4 pt-4"><h3 className="truncate text-[13px] font-bold text-[#0F2A43]">Grand livre</h3><span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#0F2A43]/45">Extrait</span></div><div className="overflow-x-auto"><table className="w-full min-w-[280px] border-collapse text-left text-[11px] sm:text-xs"><thead><tr className="text-[#0F2A43]/45"><th className="px-4 py-2.5 font-bold">Compte</th><th className="hidden px-2 py-2.5 font-bold min-[560px]:table-cell">Libellé</th><th className="px-4 py-2.5 text-right font-bold">Statut</th></tr></thead><tbody>{ROWS.map((row, index) => (<tr key={row.account} className={index % 2 ? "bg-[#F7F5F0]" : "bg-white"}><td className="whitespace-nowrap px-4 py-2.5 font-bold text-[#0F2A43]">{row.account}</td><td className="hidden truncate px-2 py-2.5 text-[#0F2A43]/65 min-[560px]:table-cell">{row.label}</td><td className="px-4 py-2 text-right"><StatusPill tone={row.tone}>{row.status}</StatusPill></td></tr>))}</tbody></table></div></section>
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}
