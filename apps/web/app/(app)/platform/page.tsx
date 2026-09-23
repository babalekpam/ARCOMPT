import { redirect } from "next/navigation";
import { apiTry } from "@/lib/api";
import { getPlatformAdmin } from "@/lib/platform";
import { requireAuthContext } from "@/lib/auth";
import type { Company } from "@/lib/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert } from "@/components/ui/Alert";
import { PlatformCompanyList } from "@/components/platform/PlatformCompanyList";

export default async function PlatformPage() {
  await requireAuthContext();
  if (!(await getPlatformAdmin())) redirect("/dashboard");
  const result = await apiTry<{ companies: Company[] }>("/platform/companies");
  return (
    <>
      <PageHeader title="Platform companies" subtitle="Choose a company to administer." />
      <Alert tone="warning" className="mb-5">
        Global platform access is highly privileged. You are viewing every company and will act as its owner after selecting one.
      </Alert>
      {!result.ok ? (
        <Alert tone="danger">Companies could not be loaded. Please try again.</Alert>
      ) : (
        <PlatformCompanyList companies={result.data.companies ?? []} />
      )}
    </>
  );
}