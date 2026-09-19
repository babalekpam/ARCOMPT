import { apiTry } from "@/lib/api";
import { getT } from "@/lib/i18n-server";
import type { Account } from "@/lib/types";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { AccountTree } from "@/components/accounts/AccountTree";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function AccountsPage() {
  const { t } = await getT();
  const res = await apiTry<{ accounts: Account[] }>("/accounts", { query: { includeInactive: "true" } });
  return (
    <>
      <PageHeader title={t("accounts.title")} subtitle={t("accounts.subtitle")} />
      {!res.ok ? <ApiErrorNotice error={res.error} /> : null}
      {res.ok && res.data.accounts.length === 0 ? <EmptyState title={t("accounts.empty")} icon="⌗" /> : null}
      {res.ok && res.data.accounts.length > 0 ? <AccountTree accounts={res.data.accounts} /> : null}
    </>
  );
}
