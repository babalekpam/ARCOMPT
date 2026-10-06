export default function PlatformLoading() {
  return <section aria-label="Chargement de l’administration" aria-busy="true" className="animate-pulse space-y-6">
    <div className="h-8 w-64 max-w-full rounded bg-slate-200 dark:bg-slate-800" />
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <div key={i} className="h-28 rounded-xl bg-slate-200 dark:bg-slate-800" />)}</div>
    <div className="h-60 rounded-xl bg-slate-200 dark:bg-slate-800" />
    <p className="sr-only">Chargement des statistiques et des organisations…</p>
  </section>;
}
