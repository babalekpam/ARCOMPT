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
      <h1 className="mb-6 text-2xl font-semibold">Account and sign-in security</h1>
      <ClerkUserProfile />
    </main>
  );
}