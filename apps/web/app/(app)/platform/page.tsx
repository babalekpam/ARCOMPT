import { redirect } from "next/navigation";
import { apiTry } from "@/lib/api";
import { getPlatformAdmin } from "@/lib/platform";
import { requireAuthContext } from "@/lib/auth";
import type { PlatformOverview as Overview } from "@/lib/platform-overview";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert } from "@/components/ui/Alert";
import { PlatformOverview } from "@/components/platform/PlatformOverview";

export const dynamic = "force-dynamic";

export default async function PlatformPage() {
  await requireAuthContext();
  if (!(await getPlatformAdmin())) redirect("/dashboard");
  const result = await apiTry<Overview>("/platform/overview", { headers: { "X-Tenant-Id": "" } });
  return (
    <>
      <PageHeader title="Vue d’ensemble" subtitle="Administration plateforme · organisations clientes et dossiers" />
      <details className="mb-4 text-xs text-slate-600 dark:text-slate-400">
        <summary className="cursor-pointer py-1 font-medium">Accès super-admin journalisé · périmètre des droits</summary>
        <p className="mt-2 max-w-2xl leading-relaxed">Sélectionner un dossier ouvre son espace avec les droits administrateur ; les opérations restent limitées à ce dossier.</p>
      </details>
      {!result.ok ? (
        <Alert tone="danger">
          La vue d’ensemble est indisponible. Aucun total n’a été estimé.
          <Link href="/platform" className="mt-2 block font-semibold underline">Réessayer</Link>
        </Alert>
      ) : (
        <PlatformOverview overview={result.data} />
      )}
    </>
  );
}