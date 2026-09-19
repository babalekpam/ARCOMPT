import { describeApiError, type ApiError, type ApiUnreachableError } from "@/lib/api";
import { getT } from "@/lib/i18n-server";
import { Alert } from "@/components/ui/Alert";

/** Affiche une erreur d'API dans un composant serveur (auth → conseil de reconnexion). */
export async function ApiErrorNotice({ error }: { error: ApiError | ApiUnreachableError }) {
  const { t } = await getT();
  const d = describeApiError(error);
  return <Alert tone={"status" in error && error.isAuth ? "warning" : "danger"}>{t(d.key, d.params)}</Alert>;
}
