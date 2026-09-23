// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { getAuthContext } from "@/lib/auth";

/** Zone authentifiée : redirige vers /login sans session, sinon affiche la coque. */
export default async function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");
  return <AppShell auth={auth}>{children}</AppShell>;
}
