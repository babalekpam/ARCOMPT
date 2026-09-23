"use client";

import { SignUp } from "@clerk/nextjs";

export function ClerkSignUp() {
  return <SignUp path="/sign-up" routing="path" signInUrl="/login" forceRedirectUrl="/api/session/landing" />;
}