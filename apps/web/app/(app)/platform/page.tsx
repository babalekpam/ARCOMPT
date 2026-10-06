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
      <PageHeader title="Administration plateforme" subtitle="Vue d’ensemble des organisations clientes et de leurs dossiers." />
      <Alert tone="warning" className="mb-5">
        Accès super-admin journalisé. Sélectionner un dossier ouvre son espace avec les droits administrateur ; les opérations restent limitées à ce dossier.
      </Alert>
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