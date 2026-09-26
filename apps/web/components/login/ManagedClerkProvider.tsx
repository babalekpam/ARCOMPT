"use client";

import { ClerkProvider } from "@clerk/nextjs";
import type { ComponentProps } from "react";
import { clerkPublishableKey, type ClerkHosting } from "@/lib/clerk-hosting";

type Props = ComponentProps<typeof ClerkProvider> & { hosting: ClerkHosting };

/** SSR receives the request-derived key; hydration uses the browser hostname. */
export function ManagedClerkProvider({ hosting, publishableKey, proxyUrl, ...props }: Props) {
  const key = typeof window === "undefined" ? publishableKey : clerkPublishableKey(window.location.hostname, {
    CLERK_HOSTING: hosting,
    CLERK_PUBLISHABLE_KEY: publishableKey,
  });
  return <ClerkProvider {...props} publishableKey={key} proxyUrl={proxyUrl} />;
}