/**
 * Identité ARCOMPT : la marque, la pastille et le logotype horizontal.
 *
 * La marque est un « A » à sommet plat dont les deux jambes portent la même
 * masse (débit à gauche, crédit à droite) et dont la barre est le trait de
 * totalisation, qui déborde de part et d'autre comme sur un registre.
 *
 * Tracé canonique sur une grille 32×32, un seul contour et un seul contre-poinçon :
 * il est documenté dans `docs/BRAND.md` et recopié à l'identique dans
 * `apps/web/public/*.svg` et `packages/render/src/html.ts`. Toute retouche doit
 * être répercutée aux trois endroits (aucun paquet partagé pour un simple tracé).
 */

/** Tracé de la marque, grille 32×32. Voir docs/BRAND.md. */
export const BRAND_MARK_PATH =
  "M11.8 3 H20.2 L25.93 18.2 H28.5 V22 H27.36 L30 29 H22.2 L19.62 22 H12.38 L9.8 29 H2 L4.64 22 H3.5 V18.2 H6.07 Z M16 12.2 L13.79 18.2 H18.21 Z";

/**
 * La marque seule, en `currentColor` : elle prend la couleur du texte
 * environnant et fonctionne donc sur fond clair comme sur fond sombre.
 * Sans `title`, elle est décorative et masquée aux lecteurs d'écran.
 */
export function BrandMark({ className = "", title }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="currentColor" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <path d={BRAND_MARK_PATH} />
    </svg>
  );
}

type Size = "sm" | "md" | "lg";

const TILE: Record<Size, string> = {
  sm: "h-7 w-7 rounded-md",
  md: "h-8 w-8 rounded-lg",
  lg: "h-9 w-9 rounded-lg",
};

const GLYPH: Record<Size, string> = {
  sm: "h-4 w-4",
  md: "h-[1.15rem] w-[1.15rem]",
  lg: "h-5 w-5",
};

const WORD: Record<Size, string> = {
  sm: "text-base",
  md: "text-lg",
  lg: "text-xl",
};

/** Pastille pleine : vert registre sur fond clair, vert clair sur fond sombre. */
export function BrandTile({ size = "md", className = "", title }: { size?: Size; className?: string; title?: string }) {
  return (
    <span className={`grid shrink-0 place-items-center bg-brand text-white dark:bg-brand-light dark:text-slate-950 ${TILE[size]} ${className}`}>
      <BrandMark className={GLYPH[size]} title={title} />
    </span>
  );
}

/**
 * Logotype horizontal : pastille + nom. Le nom reste un texte (police de
 * l'interface, approche resserrée) : il reste net à toute taille, sélectionnable
 * et lisible par les lecteurs d'écran.
 */
export function BrandLockup({ name = "ARCOMPT", size = "md", className = "" }: { name?: string; size?: Size; className?: string }) {
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <BrandTile size={size} />
      <span className={`font-semibold tracking-tight ${WORD[size]}`}>{name}</span>
    </span>
  );
}
