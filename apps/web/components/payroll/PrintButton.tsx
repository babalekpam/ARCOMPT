// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useT } from "@/lib/i18n-client";
import { Button } from "@/components/ui/Button";

/** Impression du bulletin via la boîte de dialogue du navigateur. */
export function PrintButton() {
  const t = useT();
  return (
    <Button variant="secondary" size="sm" onClick={() => window.print()} className="print:hidden">
      {t("payroll.print")}
    </Button>
  );
}
