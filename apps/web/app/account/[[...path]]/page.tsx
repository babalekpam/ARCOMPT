import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { ClerkUserProfile } from "@/components/login/ClerkUserProfile";
import { config } from "@/lib/config";

export default async function AccountPage() {
  if (config.authMode() !== "clerk") redirect("/login");
  const { userId } = await auth();
  if (!userId) redirect("/login");

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <Link href="/api/session/landing" className="mb-6 inline-block text-sm font-medium text-sky-700 underline dark:text-sky-300">
        Return to ARCOMPT
      </Link>
      <h1 className="mb-6 text-2xl font-semibold">Compte et sécurité</h1>
      <Link href="/account/security" className="mb-6 block rounded-xl border border-sky-200 bg-sky-50 p-4 font-medium text-sky-800 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200">
        Configurer ou vérifier la double authentification ARCOMPT →
      </Link>
      <ClerkUserProfile />
    </main>
  );
}