"use client";

import { ClerkLoaded, ClerkLoading, SignIn } from "@clerk/nextjs";

/** Clerk owns password reset and recovery; no reset token is handled by ARCOMPT. */
export function ClerkSignIn({ loadingLabel }: { loadingLabel: string }) {
  return (
    <>
      <ClerkLoading>
        <p role="status" className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-sky-700" />
          {loadingLabel}
        </p>
      </ClerkLoading>
      <ClerkLoaded>
        <SignIn
          path="/login"
          routing="path"
          signUpUrl="/sign-up"
          forceRedirectUrl="/api/session/landing"
        />
      </ClerkLoaded>
    </>
  );
}