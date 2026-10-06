import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth";
import { SecurityPanel } from "@/components/account/SecurityPanel";

/** Independent of the tenant shell: even a first-time Clerk user can set up MFA. */
export default async function SecurityPage() {
  if (!await getAuthContext()) redirect("/login");
  return (
    <main className="mx-auto min-h-[100dvh] max-w-2xl px-4 py-8 sm:py-10">
      <Link href="/account" className="text-sm font-medium text-sky-700 underline dark:text-sky-300">← Retour au compte</Link>
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">Sécurité du compte</h1>
      <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">Vous êtes sur la page de double authentification, pas sur le tableau de bord. L’administration de la plateforme s’ouvre après activation du mode super-admin ci-dessous.</p>
      <SecurityPanel />
    </main>
  );
}