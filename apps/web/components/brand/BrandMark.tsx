// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Identité ARCOMPT : la marque, la pastille et le logotype horizontal.
 *
 * La marque est le monogramme « Concept B », approuvé par le propriétaire le
 * 2026-11-12 : la lettre A formée de cinq colonnes de grand livre, traversée
 * par une ligne réglée verte, posée sur une ligne de base. Voir
 * `docs/BRAND.md` pour la palette, les zones de protection et les tailles
 * minimales.
 *
 * C'est un **tracé vectoriel** (SVG), dessiné aux couleurs de la marque :
 * marine encre `#0F2A43` et vert `#0E9F6E`. Elle ne peut pas hériter de
 * `currentColor` et exige un fond clair (les colonnes marine disparaissent
 * sur fond sombre). `BrandTile` fournit ce fond clair dans les deux
 * thèmes ; c'est la seule différence visible pour les appelants.
 */

/**
 * Chemin de la marque (SVG vectoriel, fond transparent, viewBox 120 × 120).
 *
 * Le nom `BRAND_MARK_PATH` est conservé pour ne pas casser les imports.
 * Les déclinaisons matricielles dérivées du même tracé vivent à
 * `/brand/arcompt-mark-512.png` et `/brand/arcompt-mark-128.png` (cette
 * dernière sert notamment de `logoImageUrl` Clerk dans `app/layout.tsx`),
 * le logotype horizontal à `/brand/arcompt-logo.svg` et la pastille
 * applicative à `/brand/arcompt-tile.svg`.
 */
export const BRAND_MARK_PATH = "/brand/arcompt-mark.svg";

/** Boîte d'affichage de `BRAND_MARK_PATH` : obligatoire pour éviter tout décalage de mise en page (le viewBox du SVG est carré, 120 × 120). */
const MARK_W = 128;
const MARK_H = 128;

/**
 * La marque seule, sur fond transparent.
 *
 * Sans `title`, elle est décorative : `alt=""` et `aria-hidden` la retirent de
 * l'arbre d'accessibilité. Avec `title`, ce texte devient son `alt`.
 * Elle a besoin d'un fond clair pour rester lisible — voir `BrandTile`.
 */
export function BrandMark({ className = "", title }: { className?: string; title?: string }) {
  return (
    // Balise `img` brute et non `next/image` : la marque est un fichier statique
    // de /public, vectoriel et léger ; l'optimiseur n'aurait rien à faire.
    <img
      src={BRAND_MARK_PATH}
      width={MARK_W}
      height={MARK_H}
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
      decoding="async"
      className={className}
    />
  );
}

type Size = "sm" | "md" | "lg";

const TILE: Record<Size, string> = {
  sm: "h-7 w-7 rounded-md",
  md: "h-8 w-8 rounded-lg",
  lg: "h-9 w-9 rounded-lg",
};

/** ~75 % de la pastille, comme documenté dans docs/BRAND.md. */
const GLYPH: Record<Size, string> = {
  sm: "h-5 w-5",
  md: "h-6 w-6",
  lg: "h-7 w-7",
};

const WORD: Record<Size, string> = {
  sm: "text-base",
  md: "text-lg",
  lg: "text-xl",
};

/**
 * Pastille : fond blanc dans les deux thèmes.
 *
 * La marque porte ses couleurs en propre et ne peut pas hériter de
 * `currentColor` : ses colonnes marine disparaîtraient sur un fond sombre.
 * La pastille reste donc claire en thème sombre, cernée d'un liseré discret
 * pour ne pas flotter.
 */
export function BrandTile({ size = "md", className = "", title }: { size?: Size; className?: string; title?: string }) {
  return (
    <span
      className={`grid shrink-0 place-items-center bg-white ring-1 ring-slate-900/10 dark:ring-white/20 ${TILE[size]} ${className}`}
    >
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
