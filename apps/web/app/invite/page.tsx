import { requireAuthContext } from "@/lib/auth";
import { getT } from "@/lib/i18n-server";
import { AcceptInvitationForm } from "@/components/firm/AcceptInvitationForm";
import { Card, CardTitle } from "@/components/ui/Card";

/** Tenant-free entry point for a signed-in colleague's first invitation. */
export default async function InvitePage() {
  await requireAuthContext();
  const { t } = await getT();
  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <Card>
        <CardTitle hint={t("firm.invitations.acceptHint")}>{t("firm.invitations.accept")}</CardTitle>
        <AcceptInvitationForm />
      </Card>
    </main>
  );
}