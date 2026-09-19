import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { ForecastView } from "@/components/treasury/ForecastView";
import type { TreasuryAccount } from "@/components/treasury/types";
import { LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";

/** Prévision de trésorerie à 13 semaines (POST /v1/treasury/forecast). */
export default async function ForecastPage() {
  const { t } = await getT();
  const res = await apiTry<TreasuryAccount[]>("/treasury/accounts");
  return (
    <>
      <PageHeader
        title={t("treasury.forecast.title")}
        subtitle={t("treasury.forecast.subtitle")}
        actions={
          <LinkButton href="/treasury" variant="ghost" size="sm">
            ← {t("treasury.title")}
          </LinkButton>
        }
      />
      {!res.ok ? <ApiErrorNotice error={res.error} /> : null}
      <Card>
        <ForecastView accounts={res.ok ? res.data : []} currency={config.defaultCurrency()} />
      </Card>
    </>
  );
}
