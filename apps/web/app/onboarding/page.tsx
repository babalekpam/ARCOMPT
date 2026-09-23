// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth";
import { BrandLockup } from "@/components/brand/BrandMark";
import { Card } from "@/components/ui/Card";
import { CreateFirstCompanyForm } from "@/components/onboarding/CreateFirstCompanyForm";

export default async function OnboardingPage() {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");
  if (auth.mode !== "clerk") redirect("/dashboard");
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-4 py-10">
      <div className="mb-6"><BrandLockup name="ARCOMPT" size="lg" /></div>
      <Card>
        <h1 className="text-xl font-semibold">Créer votre entreprise</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          Configurez votre premier dossier comptable. Vous en serez le propriétaire ; aucun accès à une entreprise existante n’est créé.
        </p>
        <CreateFirstCompanyForm />
      </Card>
    </main>
  );
}