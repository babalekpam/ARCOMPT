import type { SearchParams } from "@/lib/fiscal-year";
import { getT } from "@/lib/i18n-server";
import { loadInvoicingContext } from "@/components/invoicing/pack";
import { PaymentForm } from "@/components/invoicing/PaymentForm";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function NewPaymentPage({ searchParams }: { searchParams: SearchParams }) {
  const { t } = await getT();
  const sp = await searchParams;
  const ctx = await loadInvoicingContext();
  return (
    <>
      <PageHeader title={t("invoicing.payments.new")} subtitle={t("invoicing.payments.newSubtitle")} />
      <Card>
        <PaymentForm currency={ctx.currency} initialKind={sp.kind === "DISBURSEMENT" ? "DISBURSEMENT" : "RECEIPT"} />
      </Card>
    </>
  );
}
