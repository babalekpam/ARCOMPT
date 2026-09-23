import Link from "next/link";
import { requireAuthContext } from "@/lib/auth";
import { Card } from "@/components/ui/Card";
import { RetrySignIn } from "@/components/login/RetrySignIn";

export default async function AccessPendingPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  await requireAuthContext();
  const reason = (await searchParams).reason;
  const content = reason === "unavailable"
    ? ["Account check unavailable", "We could not verify your account right now. Please try again later."]
    : reason === "session"
      ? ["Session expired", "Your sign-in could not be verified. Sign out and sign in again."]
      : reason === "mfa"
        ? ["Second factor required", "Your account needs multi-factor authentication. Enroll a second factor in your Clerk account, then sign in again."]
        : reason === "suspended"
          ? ["Account suspended", "Please contact your organization administrator to restore access."]
          : reason === "denied"
            ? ["Access denied", "Your account could not be authorized. Please contact your organization administrator."]
            : ["No company access yet", "Your login is active, but it is not linked to a company in ARCOMPT. Ask your company administrator for access."];
  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <Card>
        <h1 className="text-xl font-semibold">{content[0]}</h1>
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
          {content[1]}
        </p>
        {reason === "session" || reason === "mfa" ? <RetrySignIn /> : null}
        {reason === "unavailable" ? <Link href="/api/session/landing" className="mt-5 inline-block text-sm font-medium text-teal-700 underline dark:text-teal-300">Try again</Link> : null}
        <Link href="/" className="mt-5 inline-block text-sm font-medium text-teal-700 underline dark:text-teal-300">
          Return to home
        </Link>
      </Card>
    </main>
  );
}