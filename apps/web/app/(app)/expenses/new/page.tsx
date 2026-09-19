import type { SearchParams } from "@/lib/fiscal-year";
import { getT } from "@/lib/i18n-server";
import { loadInvoicingContext } from "@/components/invoicing/pack";
import { PurchaseDocumentForm } from "@/components/invoicing/PurchaseDocumentForm";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nouvelle facture fournisseur ou note de frais ; `?documentId=` relie une pièce capturée. */
export default async function NewExpensePage({ searchParams }: { searchParams: SearchParams }) {
  const { t } = await getT();
  const sp = await searchParams;
  const kind = sp.kind === "EXPENSE_CLAIM" ? "EXPENSE_CLAIM" : "SUPPLIER_INVOICE";
  const documentId = typeof sp.documentId === "string" && UUID_RE.test(sp.documentId) ? sp.documentId : undefined;
  const ctx = await loadInvoicingContext();
  return (
    <>
      <PageHeader title={kind === "EXPENSE_CLAIM" ? t("invoicing.expense.newClaim") : t("invoicing.expense.newInvoice")} subtitle={t("invoicing.form.subtitle", { pack: ctx.packCode.toUpperCase(), currency: ctx.currency })} />
      <Card>
        <PurchaseDocumentForm rates={ctx.rates} currency={ctx.currency} initialKind={kind} documentId={documentId} />
      </Card>
    </>
  );
}
