// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { signIn } from "@/auth";
import { buttonClass } from "@/components/ui/Button";

/** Auth.js garde la gestion de la redirection OIDC (state/PKCE) pour les deux parcours. */
export function KeycloakButton({ label, resetLabel, resetHint }: { label: string; resetLabel: string; resetHint: string }) {
  return (
    <div>
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
      <form
        className="mt-4 text-center"
        action={async () => {
          "use server";
          // L'IdP gère les codes, leur expiration et l'envoi. Ne jamais créer
          // de mot de passe ni de jeton de réinitialisation côté ARCOMPT.
          await signIn("keycloak", { redirectTo: "/dashboard" }, { prompt: "login" });
        }}
      >
        <button type="submit" className="text-sm font-medium text-sky-700 underline underline-offset-4 hover:text-sky-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700">
          {resetLabel}
        </button>
        <p className="mt-1 text-xs text-slate-500">{resetHint}</p>
      </form>
    </div>
  );
}
