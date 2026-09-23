// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import type { PaymentStatus, PurchaseStatus, SalesStatus } from "./types";

/** Teinte d'un statut de document de vente. */
export function salesStatusTone(status: SalesStatus): BadgeTone {
  switch (status) {
    case "PAID":
    case "ACCEPTED":
      return "success";
    case "SENT":
      return "info";
    case "PARTIALLY_PAID":
      return "warning";
    case "CANCELLED":
    case "REFUSED":
      return "danger";
    default:
      return "neutral";
  }
}

export function purchaseStatusTone(status: PurchaseStatus): BadgeTone {
  switch (status) {
    case "PAID":
      return "success";
    case "POSTED":
      return "info";
    case "PARTIALLY_PAID":
      return "warning";
    case "CANCELLED":
      return "danger";
    default:
      return "neutral";
  }
}

export function paymentStatusTone(status: PaymentStatus): BadgeTone {
  switch (status) {
    case "RECORDED":
      return "success";
    case "PENDING_APPROVAL":
      return "warning";
    case "REVIEW":
      return "info";
    case "REJECTED":
      return "danger";
  }
}

/** Badge de statut (serveur ou client) : la teinte vient du statut, le libellé du traducteur. */
export function DocStatusBadge({ tone, label }: { tone: BadgeTone; label: string }) {
  return <Badge tone={tone}>{label}</Badge>;
}
