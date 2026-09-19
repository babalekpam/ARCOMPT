import { config } from "@/lib/config";
import { getT } from "@/lib/i18n-server";
import { DocumentsNav } from "@/components/documents/DocumentsNav";
import { UploadFlow } from "@/components/documents/UploadFlow";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function UploadDocumentPage() {
  const { t } = await getT();
  return (
    <>
      <PageHeader title={t("documents.upload.title")} subtitle={t("documents.upload.subtitle")} />
      <DocumentsNav />
      <div className="max-w-3xl">
        <UploadFlow currency={config.defaultCurrency()} />
      </div>
    </>
  );
}
