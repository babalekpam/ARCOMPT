import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth";
import { MfaSecurity } from "@/components/account/MfaSecurity";

/** Independent of the tenant shell: even a first-time Clerk user can set up MFA. */
export default async function SecurityPage() {
  if (!await getAuthContext()) redirect("/login");
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <Link href="/account" className="text-sm font-medium text-sky-700 underline dark:text-sky-300">← Retour au compte</Link>
      <MfaSecurity />
    </main>
  );
}