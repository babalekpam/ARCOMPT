const modules = [
  { name: "Moteur comptable", phase: 0, state: "Disponible : grand livre, invariants, import de balance" },
  { name: "États financiers", phase: 1, state: "Disponible : bilan, compte de résultat, TFT, notes, contrôles" },
  { name: "Portail cabinets", phase: 1, state: "À venir : multi-dossiers, revue, visa, dépôt" },
  { name: "Facturation et dépenses", phase: 2, state: "À venir : devis, factures, capture par IA" },
  { name: "Trésorerie", phase: 2, state: "À venir : banque, caisse, mobile money" },
  { name: "Paie et fiscalité", phase: 3, state: "À venir : bulletins, TVA, DSF, facture certifiée" },
];

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">ARCOMPT</h1>
      <p className="mt-2 text-slate-600 dark:text-slate-300">La comptabilité intelligente des PME de l&apos;espace OHADA. Le grand livre est la seule source de vérité ; l&apos;IA propose, l&apos;humain valide.</p>
      <ul className="mt-8 divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {modules.map((m) => (
          <li key={m.name} className="flex items-start justify-between gap-4 px-4 py-3">
            <div>
              <div className="font-medium">{m.name}</div>
              <div className="text-sm text-slate-500 dark:text-slate-400">{m.state}</div>
            </div>
            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">phase {m.phase}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
