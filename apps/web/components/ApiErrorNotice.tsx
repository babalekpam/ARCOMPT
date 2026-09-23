import { describeApiError, packRefusal, type ApiError, type ApiUnreachableError } from "@/lib/api";
import { getT } from "@/lib/i18n-server";
import { Alert } from "@/components/ui/Alert";

/**
 * Affiche une erreur d'API dans un composant serveur (auth → conseil de
 * reconnexion). Le refus d'un pack non publié n'est pas une panne : c'est une
 * garde qui a fonctionné, d'où le ton d'avertissement plutôt que d'erreur.
 */
export async function ApiErrorNotice({ error }: { error: ApiError | ApiUnreachableError }) {
  const { t } = await getT();
  const d = describeApiError(error);
  const expected = packRefusal(error) !== null || ("status" in error && error.isAuth);
  return <Alert tone={expected ? "warning" : "danger"}>{t(d.key, d.params)}</Alert>;
}
