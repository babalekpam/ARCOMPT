"use client";
import { useClerk } from "@clerk/nextjs";
import { resetOfflineServices } from "@/lib/offline-browser";

export function RetrySignIn() {
  const { signOut } = useClerk();
  return (
    <button type="button" className="mt-5 block text-sm font-medium text-teal-700 underline dark:text-teal-300"
      onClick={async () => {
        try {
          await fetch("/api/session/logout", { method: "POST" });
          resetOfflineServices();
          await signOut({ redirectUrl: "/login" }).catch(() => undefined);
        } finally {
          window.location.replace("/login");
        }
      }}>
      Sign out and sign in again
    </button>
  );
}