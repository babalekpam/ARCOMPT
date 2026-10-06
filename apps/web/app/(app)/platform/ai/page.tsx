import { redirect } from "next/navigation";
import { requireAuthContext } from "@/lib/auth";
import { getPlatformAdmin } from "@/lib/platform";
import { PageHeader } from "@/components/ui/PageHeader";
import { LinkButton } from "@/components/ui/Button";
import { PlatformAiSettings } from "@/components/platform/PlatformAiSettings";

export const dynamic = "force-dynamic";

export default async function PlatformAiPage() {
  await requireAuthContext();
  if (!(await getPlatformAdmin())) redirect("/dashboard");
  return <>
    <PageHeader title="Fournisseurs IA" subtitle="Configuration globale · accès super-admin vérifié" actions={<LinkButton href="/platform" variant="ghost">Vue d’ensemble admin</LinkButton>} />
    <PlatformAiSettings />
  </>;
}
