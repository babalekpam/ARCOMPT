# Identité visuelle ARCOMPT

ARCOMPT est un logiciel de comptabilité destiné aux PME et aux cabinets d'expertise
comptable de l'espace OHADA. L'identité doit inspirer la même confiance qu'un
registre relié : sobre, stable, lisible sur un téléphone Android d'entrée de gamme
comme sur une liasse imprimée en noir et blanc. Elle n'est pas là pour séduire,
elle est là pour rassurer.

Trois pistes ont été dessinées puis éprouvées au rendu réel à 16, 20, 24, 32, 64 et
160 px, sur fond clair et sur fond sombre. **La piste A a été retenue.**

---

## Règles communes aux trois pistes

- Tracés écrits à la main sur une grille **32 × 32**, en coordonnées entières ou au
  centième. Pas de bibliothèque, pas de vectorisation d'image, pas de dégradé.
- **Un seul contour et un seul contre-poinçon** par marque : le fichier reste sous
  400 octets et le rendu ne bave pas à petite taille.
- La marque se remplit en `currentColor` : elle prend la couleur du texte qui
  l'entoure et fonctionne donc partout sans variante de fichier.
- Aucune des pistes n'emploie de graphique en barres, de flèche ascendante, de
  globe, de poignée de main ni de virgule abstraite.

---

## Piste A — « L'A comptable » *(retenue)*

> Un **A** dont les deux jambes portent la même masse — débit à gauche, crédit à
> droite — réunies par la barre de totalisation, qui déborde comme un filet de
> registre.

Le sommet est coupé à plat : la lettre cesse d'être un « A » de traitement de texte
et devient une forme frappée. La barre n'est pas le trait d'une lettre mais le
**trait de totalisation** : elle dépasse des deux jambes, exactement comme le filet
qu'un comptable tire sous une colonne avant d'en écrire le total.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="currentColor">
  <path d="M11.8 3 H20.2 L25.93 18.2 H28.5 V22 H27.36 L30 29 H22.2 L19.62 22 H12.38 L9.8 29 H2 L4.64 22 H3.5 V18.2 H6.07 Z M16 12.2 L13.79 18.2 H18.21 Z"/>
</svg>
```

**Logotype horizontal** — pastille pleine + nom. Le nom reste un texte composé dans
la police de l'interface (graisse 600, approche `-0.025em`) : il demeure net à
toute taille, sélectionnable et lu par les lecteurs d'écran.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 32" fill="none">
  <rect width="32" height="32" rx="7" fill="#0E5B46"/>
  <path transform="translate(3.84 3.84) scale(.76)" fill="#fff"
        d="M11.8 3 H20.2 L25.93 18.2 H28.5 V22 H27.36 L30 29 H22.2 L19.62 22 H12.38 L9.8 29 H2 L4.64 22 H3.5 V18.2 H6.07 Z M16 12.2 L13.79 18.2 H18.21 Z"/>
  <text x="42" y="23" font-family="ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif"
        font-size="19" font-weight="600" letter-spacing="-.5" fill="#0F172A">ARCOMPT</text>
</svg>
```

> Ce logotype autonome dépanne (courriel, présentation). **Pour l'impression,
> vectoriser le texte.** Dans le produit, c'est le composant React qui fait foi.

**Version bichrome (facultative)** — la lettre est fendue **verticalement** en son
axe : jambe gauche en vert, jambe droite en ocre. Le partage reprend la convention
de tout journal francophone — *débit à gauche, crédit à droite* — et se réduit
sans perte à la version monochrome, qui reste la version par défaut.

### Pourquoi cette piste

1. **Elle survit à 16 px en gardant son sens.** C'est la seule des trois : à cette
   taille, B et C ne sont plus que des taches, alors que le A reste un A.
2. **La marque et le nom se renforcent.** L'initiale du produit *est* l'idée du
   produit ; aucune des deux ne doit être expliquée.
3. **Le partage bichrome dit quelque chose de vrai** (débit/crédit) au lieu de
   décorer, et disparaît proprement en monochrome.
4. **C'est une lettre, pas un pictogramme.** Elle ne ressemblera jamais au premier
   résultat d'une banque d'images, et elle ne vieillira pas comme un symbole.

---

## Piste B — « Le contre-passement » *(non retenue)*

> Un carré plein fendu par une saignée en Z. Les deux moitiés sont **superposables
> par rotation de 180°** : la même écriture vue de l'autre côté.

L'idée est juste — la partie double est précisément une symétrie de rotation, pas
un miroir — et la forme est dense, donc visible en petit.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="currentColor">
  <path d="M3 3 H29 V9 H14 V19 H3 Z"/>
  <path d="M3 23 H18 V13 H29 V29 H3 Z"/>
</svg>
```

**Écartée parce que** : à 64 px et au-delà, la forme se lit « S » ou « 5 ». Pour une
marque dont le nom commence par A, c'est un contresens permanent. Et à 16 px elle
reste lisible mais ne *signifie* plus rien : on voit un carré entaillé, pas une
contrepartie.

---

## Piste C — « Le losange tissé » *(non retenue)*

> Le losange des bandes tissées, coupé à la taille : deux triangles d'aire
> strictement égale, séparés par le trait où ils s'équilibrent.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="currentColor">
  <path d="M16 2 L28.6 14.6 H3.4 Z"/>
  <path d="M3.4 17.4 H28.6 L16 30 Z"/>
</svg>
```

**Écartée parce que** : en bichrome, les deux triangles se lisent comme une flèche
montante et une flèche descendante — exactement le cliché à éviter. Et le losange
seul reste trop générique : il n'appartient à personne.

### Note sur l'emprunt culturel

Cette piste s'inspirait de la **grammaire de construction** des étoffes et des
tampons d'Afrique de l'Ouest (trame en losanges, trait d'épaisseur constante,
symétrie bilatérale, forme close sur un champ carré) — et **non** d'un symbole
nommé.

Deux symboles adinkra ont été étudiés avant d'écarter cette voie :

- **Fihankra** — la concession close, à entrée unique : sécurité, sûreté,
  solidarité. ([source](https://www.adinkrasymbols.org/symbols/fihankra/))
- **Nsaa** — une étoffe tissée de qualité ; excellence, authenticité, d'après le
  proverbe akan *« Nea onnim nsaa na oto n'ago »*, « qui ne connaît pas le vrai
  nsaa achètera la contrefaçon ».
  ([source](https://www.adinkrasymbols.org/symbols/nsaa/))

Les deux sens conviendraient au produit. **Aucun des deux n'a été reproduit**, pour
deux raisons. D'abord parce que l'adinkra est **akan** — Ghana, et les populations
akan de l'est de la Côte d'Ivoire — et non panafricain : en faire l'emblème d'un
produit qui sert aussi le Sénégal, le Mali, le Cameroun, le Niger, le Bénin, le
Togo et le Burkina reviendrait à présenter la culture d'un seul peuple comme celle
de dix-sept pays. Ensuite parce que déposer un symbole traditionnel comme marque
commerciale, c'est s'approprier un bien qui n'appartient pas à l'entreprise.

**Règle pour la suite** : on peut emprunter une géométrie ; on n'emprunte pas un
nom ni le sens qui va avec. Si une piste adinkra est un jour reprise, elle doit
l'être avec des praticiens de la région, pas depuis une planche de symboles.

---

## Palette

Pas de bleu-violet dégradé : c'est la teinte par défaut de tous les SaaS, et elle
ne dit rien d'un métier ni d'une région. ARCOMPT prend un **vert d'encre** — la
couleur du registre, et celle qui domine les drapeaux de l'espace OHADA — relevé
d'un **ocre de latérite**, la terre de la région. Les neutres restent l'échelle
`slate` de Tailwind, déjà employée dans toute l'interface : la marque s'y ajoute,
elle ne force pas une refonte.

| Rôle | Fond clair | Fond sombre | Usage |
| --- | --- | --- | --- |
| **Vert registre** (primaire) | `#0E5B46` | `#4FB795` | La marque, les accents primaires, les filets. |
| **Ocre latérite** (accent) | `#C2703D` | `#D98A55` | Seconde teinte de la marque bichrome, soulignés rares. |
| **Encre** (texte) | `#0F172A` `slate-900` | `#F1F5F9` `slate-100` | Texte courant, logotype. |
| **Fonds** | `#FFFFFF` / `#F8FAFC` | `#020617` / `#0F172A` | Surfaces (inchangées). |

### Contrastes mesurés (WCAG 2.1)

| Couleur | sur `#FFFFFF` | sur `#F8FAFC` | sur `#020617` | sur `#0F172A` |
| --- | --- | --- | --- | --- |
| Vert registre `#0E5B46` | **8.07** | **7.71** | 2.50 | 2.21 |
| Vert clair `#4FB795` | 2.46 | 2.35 | **8.20** | **7.26** |
| Ocre `#C2703D` | 3.70 | 3.53 | **5.46** | **4.83** |
| Ocre clair `#D98A55` | 2.72 | 2.60 | **7.41** | **6.56** |

Le primaire dépasse 7:1 sur son propre fond (niveau AAA pour le texte courant).
**L'ocre sur fond clair plafonne à 3.70 : il passe pour un élément graphique ou un
grand titre (seuil 3:1), jamais pour du texte courant.** Vert et ocre se
distinguent aussi par la clarté (rapport 2.18:1 entre eux), donc restent
différenciables en vision dichromate — mais par principe **la bichromie ne porte
jamais seule une information** : la version monochrome est la version de
référence.

### Coexistence avec l'existant

Les gabarits PDF emploient déjà un bleu marine `#1a3a5c` pour les filets et les
titres de la liasse. La marque **ne s'y substitue pas** : au pied de page elle
hérite du gris `#666` du pied via `currentColor`, et ne croise donc jamais le
marine. Une harmonisation des deux (marine → vert, ou maintien du marine pour les
états officiels) reste une décision à prendre — voir « À reconsidérer » plus bas.

---

## Espacement et tailles minimales

- **Zone de protection** : au moins **la hauteur de la barre de totalisation**
  (≈ 1/7 de la hauteur de la marque, soit 4 unités sur la grille 32) libre de tout
  texte, filet ou bord, sur les quatre côtés. Dans le logotype, l'écart entre la
  pastille et le nom vaut `0.5rem` (8 px).
- **Taille minimale de la marque seule** : **16 px**. C'est la taille de
  validation, pas une limite théorique — elle a été rendue et vérifiée.
- **Taille minimale du logotype complet** : **20 px** de hauteur de pastille.
  En dessous, employer la marque seule ; le nom devient illisible avant la marque.
- **Pastille** : rayon d'angle `7/32` de sa hauteur (`rounded-md` à 28 px,
  `rounded-lg` à 32 et 36 px). La lettre occupe **76 %** de la pastille.
- **Icône masquable (Android)** : la lettre est ramenée à **58 %** pour tenir dans
  la zone sûre des 80 % centraux, sinon le masque du système lui coupe les pieds.

---

## Ce qu'on ne fait pas avec la marque

1. **Ne pas la redessiner en épaisseur.** Pas de contour, pas de version « outline »,
   pas de graisse variable : c'est une forme pleine.
2. **Ne pas la déformer.** Jamais d'étirement non uniforme, de rotation, d'italique
   ni de perspective. Le `viewBox` se met à l'échelle, rien d'autre.
3. **Ne pas la mettre en dégradé**, ni ombre portée, ni lueur, ni biseau.
4. **Ne pas la poser sur une photo** ni sur un fond dont le contraste avec elle
   descend sous 3:1. Sur fond chargé, employer la pastille pleine.
5. **Ne pas recolorer la bichromie librement.** Deux teintes seulement, dans le
   sens prescrit : vert à gauche (débit), ocre à droite (crédit). Jamais l'inverse.
6. **Ne pas la substituer à l'identité du client.** Sur une facture, un bulletin ou
   une liasse, l'en-tête appartient à l'entreprise qui édite le document ; ARCOMPT
   n'apparaît qu'au pied, comme logiciel producteur.
7. **Ne pas recomposer le nom.** « ARCOMPT » s'écrit en capitales, d'un bloc, sans
   espacement des lettres, sans point, sans « by ».
8. **Ne pas employer la marque seule comme favicon sans pastille** : en
   `currentColor` sur le chrome du navigateur, elle disparaîtrait.

---

## Où vit la marque dans le code

| Fichier | Rôle |
| --- | --- |
| `apps/web/components/brand/BrandMark.tsx` | `BRAND_MARK_PATH`, `BrandMark`, `BrandTile`, `BrandLockup`. |
| `apps/web/tailwind.config.ts` | Couleurs `brand`, `brand-light`, `brand-ocre`. |
| `apps/web/public/favicon.svg` | Pastille 32 × 32, source des PNG. |
| `apps/web/public/icon-{192,512}.png`, `icon-maskable-512.png`, `apple-touch-icon.png` | Icônes PWA, rendues depuis le SVG. |
| `apps/web/app/manifest.ts` | Déclaration des icônes (`any` + `maskable`). |
| `apps/web/public/offline.html` | Page hors ligne (SVG inline, aucun build). |
| `packages/render/src/html.ts` | `MARK_SVG` au pied des gabarits PDF. |

> **Le tracé est recopié à l'identique à quatre endroits**, faute de paquet partagé
> pour une simple chaîne de caractères (en créer un imposerait de toucher au
> `package.json` et au lockfile). Toute retouche du tracé vaut pour les quatre.

---

## À reconsidérer

- **Le marine `#1a3a5c` des gabarits PDF.** Il précède cette identité. Le laisser
  donne des documents officiels en marine et une application en vert ; l'aligner
  sur le vert unifierait la marque mais modifierait l'aspect de liasses que des
  utilisateurs impriment et déposent déjà. Décision volontairement non prise ici.
- **Le vert et l'interface.** La palette est déclarée dans Tailwind mais
  l'interface reste en `slate` : seuls la marque et la pastille emploient le vert.
  Passer les boutons primaires au vert est un second chantier, à mener écran par
  écran.
- **Le nom sous la marque.** Le logotype ne porte pas de signature
  (« La comptabilité intelligente des PME de l'espace OHADA »). Elle existe comme
  texte dans l'application ; en faire un élément verrouillé du logotype est à
  décider avant tout dépôt de marque.
