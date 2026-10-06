import "@/components/platform/platform.css";

export default function PlatformLoading() {
  return <section aria-label="Chargement de l’administration" aria-busy="true" className="animate-pulse space-y-6">
    <div className="h-8 w-64 max-w-full rounded bg-slate-200 dark:bg-slate-800" />
    <div className="platform-overview"><div className="platform-stats">{Array.from({ length: 5 }, (_, i) => <div key={i} className="platform-stat h-24 rounded-xl last:h-14 xl:last:h-24" />)}</div></div>
    <div className="h-60 rounded-xl bg-slate-200 dark:bg-slate-800" />
    <p className="sr-only">Chargement des statistiques et des organisations…</p>
  </section>;
}
