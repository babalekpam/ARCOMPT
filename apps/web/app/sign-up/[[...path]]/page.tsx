import { redirect } from "next/navigation";
import { ClerkSignUp } from "@/components/login/ClerkSignUp";
import { config } from "@/lib/config";

export default function SignUpPage() {
  if (config.authMode() !== "clerk") redirect("/login");
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <ClerkSignUp />
    </main>
  );
}