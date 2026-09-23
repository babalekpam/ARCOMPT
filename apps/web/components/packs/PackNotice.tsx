import { getT } from "@/lib/i18n-server";
import { Alert } from "@/components/ui/Alert";

/** Écran concerné : chaque surface qui produit un document a sa formulation. */
export type PackNoticeSurface = "vat" | "vatReturn" | "dsf" | "payslip";

/**
 * Mention d'un pack en cours de rédaction, posée une seule fois par surface qui
 * produit un document. Ailleurs — listes, fiches, écrans de tenue — un badge
 * discret suffit : un utilisateur qui a compris que son pack est un brouillon
 * n'a pas à le relire sur chaque écran.
 *
 * Les variantes `print:` importent pour le bulletin de paie : l'impression est
 * le bulletin remis au salarié, et les navigateurs n'impriment pas les fonds
 * par défaut. Le texte reste noir sur blanc, encadré, et la mention ne se coupe
 * pas entre deux pages.
 */
export async function PackNotice({ surface, pack, className = "" }: { surface: PackNoticeSurface; pack: string; className?: string }) {
  const { t } = await getT();
  return (
    <Alert tone="warning" className={`break-inside-avoid print:!border-black print:!bg-white print:!text-black ${className}`}>
      <p className="font-semibold">{t(`pack.notice.${surface}.title`, { pack })}</p>
      <p className="mt-0.5">{t(`pack.notice.${surface}.body`, { pack })}</p>
    </Alert>
  );
}
