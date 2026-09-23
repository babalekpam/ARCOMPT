"use client";

import { SignIn } from "@clerk/nextjs";

/** Clerk owns password reset and recovery; no reset token is handled by ARCOMPT. */
export function ClerkSignIn() {
  return (
    <SignIn
      path="/login"
      routing="path"
      signUpUrl="/sign-up"
      forceRedirectUrl="/api/session/landing"
    />
  );
}