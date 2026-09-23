// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { signIn } from "@/auth";
import { buttonClass } from "@/components/ui/Button";

/** Bouton Keycloak : action serveur Auth.js, redirection vers le realm OIDC. */
export function KeycloakButton({ label }: { label: string }) {
  return (
    <form
      action={async () => {
        "use server";
        await signIn("keycloak", { redirectTo: "/dashboard" });
      }}
    >
      <button type="submit" className={`${buttonClass("primary")} w-full`}>
        {label}
      </button>
    </form>
  );
}
