// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth";
import { config } from "@/lib/config";
import { getT } from "@/lib/i18n-server";
import { LocaleSwitcher } from "@/components/shell/LocaleSwitcher";
import { DevLoginForm } from "@/components/login/DevLoginForm";
import { KeycloakButton } from "@/components/login/KeycloakButton";
import { Card } from "@/components/ui/Card";
import { BrandLockup } from "@/components/brand/BrandMark";

export const metadata: Metadata = { title: "Connexion" };

export default async function LoginPage() {
  const existing = await getAuthContext();
  if (existing) redirect("/dashboard");
  const { t } = await getT();
  const mode = config.authMode();
  const kc = config.keycloak();
  const keycloakConfigured = Boolean(kc.issuer && kc.clientId && kc.clientSecret);
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <BrandLockup name={t("app.name")} size="lg" />
        <LocaleSwitcher compact />
      </div>
      <Card>
        <h1 className="text-lg font-semibold">{t("login.title")}</h1>
        <p className="mt-1 text-sm text-slate-500">{t("login.subtitle")}</p>
        <div className="mt-5">{keycloakConfigured ? <KeycloakButton label={t("login.keycloak")} resetLabel={t("login.resetPassword")} resetHint={t("login.resetHint")} /> : <p className="text-xs text-slate-500">{t("login.keycloakMissing")}</p>}</div>
      </Card>
      {mode === "dev" ? (
        <Card className="mt-4">
          <h2 className="text-base font-semibold">{t("login.devTitle")}</h2>
          <p className="mt-1 text-xs text-slate-500">{t("login.devHint")}</p>
          <DevLoginForm />
        </Card>
      ) : null}
      <p className="mt-6 text-center text-xs text-slate-400">{t("app.tagline")}</p>
    </main>
  );
}
