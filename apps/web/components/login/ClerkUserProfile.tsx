"use client";

import { UserProfile } from "@clerk/nextjs";

export function ClerkUserProfile() {
  return <UserProfile path="/account" routing="path" />;
}