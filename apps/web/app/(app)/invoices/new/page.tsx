import type { SearchParams } from "@/lib/fiscal-year";
import { getT } from "@/lib/i18n-server";
import { loadInvoicingContext } from "@/components/invoicing/pack";
import { SalesDocumentForm } from "@/components/invoicing/SalesDocumentForm";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function NewInvoicePage({ searchParams }: { searchParams: SearchParams }) {
  const { t } = await getT();
  const sp = await searchParams;
  const kind = sp.kind === "QUOTE" ? "QUOTE" : "INVOICE";
  const ctx = await loadInvoicingContext();
  return (
    <>
      <PageHeader title={kind === "QUOTE" ? t("invoicing.newQuote") : t("invoicing.newInvoice")} subtitle={t("invoicing.form.subtitle", { pack: ctx.packCode.toUpperCase(), currency: ctx.currency })} />
      <Card>
        <SalesDocumentForm rates={ctx.rates} currency={ctx.currency} initialKind={kind} packDraft={ctx.packDraft} />
      </Card>
    </>
  );
}
