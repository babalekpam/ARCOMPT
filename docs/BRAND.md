# Identité visuelle ARCOMPT

ARCOMPT est un logiciel de comptabilité destiné aux PME et aux cabinets d'expertise
comptable de l'espace OHADA. L'identité doit inspirer la même confiance qu'un
registre relié : sobre, stable, lisible sur un téléphone Android d'entrée de gamme
comme sur une liasse imprimée.

**La marque est le logo fourni par le propriétaire du produit.** Ce document décrit
ce logo, ce qu'on en dérive et ce qu'on n'en fait pas. Il ne propose pas de piste
alternative : le choix est fait en amont, hors du code.

---

## La marque

> Une calculatrice et un histogramme ascendant, balayés par deux rubans marine.

Trois couleurs pleines, aucun dégradé, aucun texte à l'intérieur de la marque.
Les surfaces blanches — l'écran et les touches de la calculatrice — **font partie
du dessin** : ce ne sont pas des trous. Sur fond coloré, le logo doit donc être
posé sur une plaque claire, pas détouré à même le fond (voir « Ce qu'on ne fait
pas », point 4).

### Fichiers source

| Fichier | Rôle |
| --- | --- |
| `apps/web/public/brand/arcompt-logo-source.jpg` | **Source du propriétaire**, telle que fournie : JPEG 740 × 740, fond blanc opaque. Référence de dernier recours. |
| `apps/web/public/brand/arcompt-mark-512.png` | Master de travail : fond détouré (transparent), recadré au dessin, 512 × 512. **C'est de ce fichier que tout le reste est dérivé.** |
| `apps/web/public/brand/arcompt-mark-128.png` | Même image en 128 × 128, servie à l'interface (la pastille ne dépasse jamais 36 px, soit 3,5× de réserve). |

Le détourage a été fait par remplissage par diffusion depuis les bords, sur les
seuls pixels blancs **connectés au fond**, ce qui préserve les blancs intérieurs
de la calculatrice. Le résultat a été vérifié composité sur fond sombre et sur
fond magenta : aucun liseré blanc résiduel.

> **La marque n'existe pas en vectoriel.** Toutes les contraintes qui suivent
> — taille minimale, favicon sur plaque, dimensions explicites dans le HTML —
> en découlent. Faire vectoriser le logo par son auteur est la seule chose qui
> les lèverait ; voir « À reconsidérer ».

---

## Palette

Relevée sur le fichier fourni, à l'échantillon : ce sont les valeurs réelles du
dessin, pas une interprétation.

| Rôle | Hex | Part du dessin | Emploi |
| --- | --- | --- | --- |
| **Marine** (primaire) | `#14324E` | 21 % | Les deux rubans, l'ombre des barres. Teinte dominante, la seule utilisable en texte. |
| **Bleu pétrole** | `#0A7693` | 8 % | Le corps de la calculatrice. |
| **Turquoise** | `#1BAD9A` | 12 % | Les barres de l'histogramme. |
| **Blanc** | `#FFFFFF` | — | L'écran et les touches. Élément du dessin, **pas** une transparence. |

Les neutres restent l'échelle `slate` de Tailwind, déjà employée dans toute
l'interface. Les jetons sont déclarés dans `apps/web/tailwind.config.ts` sous
`brand`, `brand-petrol`, `brand-teal`, `brand-light`.

### Contrastes mesurés (WCAG 2.1)

| Couleur | sur `#FFFFFF` | sur `#F8FAFC` | sur `#020617` | sur `#0F172A` |
| --- | --- | --- | --- | --- |
| Marine `#14324E` | **13.16** | **12.58** | 1.53 | 1.36 |
| Pétrole `#0A7693` | **5.22** | **4.99** | 3.87 | 3.42 |
| Turquoise `#1BAD9A` | 2.80 | 2.68 | **7.20** | **6.37** |

Lecture : **le logo est une marque de fond clair.** Le marine, qui porte 21 % du
dessin et tout le mouvement des rubans, tombe à 1,5:1 sur `slate-950` — il y
disparaît purement et simplement. Le turquoise fait l'inverse. Aucune des trois
teintes ne tient sur les deux fonds.

C'est la raison, et la seule, pour laquelle la pastille (`BrandTile`) reste
**blanche en thème sombre** au lieu de s'inverser comme le faisait l'ancienne
marque monochrome. Le liseré `ring-white/20` l'empêche de flotter.

Le turquoise `#1BAD9A` ne franchit pas 3:1 sur fond clair : **jamais de texte, ni
de filet porteur d'information, dans cette teinte sur blanc.** Il ne sert que de
surface à l'intérieur du logo.

---

## Espacement et tailles minimales

- **Zone de protection** : au moins **1/8 de la largeur de la marque** libre de
  tout texte, filet ou bord, sur les quatre côtés. Dans le logotype, l'écart
  entre la pastille et le nom vaut `0.5rem` (8 px).
- **Pastille** : la marque occupe **≈ 75 %** de la pastille (20 px dans 28,
  24 dans 32, 28 dans 36). Rayon d'angle `rounded-md` à 28 px, `rounded-lg`
  au-delà.
- **Taille minimale utile de la marque seule : 48 px.** En dessous, le clavier
  de la calculatrice et les trois barres se confondent — voir ci-dessous.
- **Taille minimale du logotype complet** : 28 px de hauteur de pastille.
- **Icône masquable (Android)** : la marque est ramenée à **58 %** de la toile,
  à fond perdu sur blanc, pour tenir dans les 80 % centraux que le masque du
  système laisse voir.
- **Dimensions explicites obligatoires.** La marque est matricielle : tout
  `<img>` qui la porte déclare `width` et `height` (128 × 128 intrinsèques) et
  un `alt`, sans quoi la mise en page saute au chargement.

---

## Lisibilité en petit — constat

Le favicon a été rendu à **16, 20, 24 et 32 px**, sur fond clair et sur fond
sombre, puis regardé. Verdict, sans complaisance :

| Taille | Ce qu'on voit réellement |
| --- | --- |
| **16 px** | **Illisible.** Une tache turquoise et marine en diagonale. Le clavier a disparu, les trois barres ont fusionné en un seul plan, les deux rubans n'en font plus qu'un. On ne reconnaît ni calculatrice, ni graphique. |
| **20 px** | **Illisible.** Le ruban inférieur commence à se détacher ; tout le reste reste une bouillie. |
| **24 px** | **Limite.** L'arc des rubans se lit, la silhouette de la calculatrice s'annonce. Le clavier reste une texture grise. |
| **32 px** | **Silhouette lisible, détail perdu.** On identifie « barres + bloc + balayage ». Les neuf touches ne sont toujours pas des touches, seulement un grain. |

Le logo demande **≈ 48 px pour être vraiment lu**. C'est le prix de trois motifs
superposés (histogramme, calculatrice, rubans) dans une marque carrée.

Le fond clair ou sombre ne change rien à ce constat : la plaque blanche isole le
dessin dans les deux cas. Elle est en revanche **indispensable** — sans elle, les
rubans marine s'effacent sur une barre d'onglets sombre. C'est pourquoi
`favicon.ico` et toutes les icônes PWA portent une plaque blanche.

**Ce qui corrigerait le problème** — et qui n'a pas été fait, faute de mandat :
un **glyphe simplifié réservé aux petites tailles** (16 → 32 px), dérivé d'un
seul élément du dessin existant, par exemple les trois barres seules en
turquoise et marine, ou le double ruban seul. Deux formes, deux couleurs, aucune
ligne fine : cela tiendrait à 16 px. C'est une décision d'identité, elle revient
au propriétaire du logo, pas à l'implémentation. **En l'état, le favicon 16 px
livré est un compromis assumé, pas un résultat satisfaisant.**

---

## Ce qu'on ne fait pas avec la marque

1. **Ne pas la recolorer.** Trois teintes, relevées sur le fichier. Pas de
   version monochrome improvisée, pas d'inversion, pas de teinte unique.
2. **Ne pas la déformer.** Jamais d'étirement non uniforme, de rotation,
   d'italique ni de perspective. On met le fichier à l'échelle, rien d'autre.
3. **Ne pas la mettre en dégradé**, ni ombre portée, ni lueur, ni biseau.
4. **Ne pas la poser sur un fond sombre ni sur une photo.** Le marine y
   disparaît (1,5:1). Sur fond chargé ou sombre : plaque blanche, toujours.
5. **Ne pas l'employer en dessous de 48 px sans plaque**, et ne pas prétendre
   qu'elle est lisible à 16 px — voir le constat ci-dessus.
6. **Ne pas la ré-agrandir depuis un petit fichier.** Toute nouvelle dérivation
   part de `arcompt-mark-512.png`, ou de la source JPEG.
7. **Ne pas la substituer à l'identité du client.** Sur une facture, un bulletin
   ou une liasse, l'en-tête appartient à l'entreprise qui édite le document ;
   ARCOMPT n'apparaît qu'au pied, comme logiciel producteur.
8. **Ne pas recomposer le nom.** « ARCOMPT » s'écrit en capitales, d'un bloc,
   sans espacement des lettres, sans point, sans « by ». Le nom reste un texte
   composé dans la police de l'interface (graisse 600, approche `-0.025em`) : il
   demeure net à toute taille, sélectionnable et lu par les lecteurs d'écran.

---

## Où vit la marque dans le code

| Fichier | Rôle |
| --- | --- |
| `apps/web/public/brand/arcompt-logo-source.jpg` | Source fournie par le propriétaire (JPEG 740 × 740, fond blanc). |
| `apps/web/public/brand/arcompt-mark-512.png` | Master détouré. Source de toutes les dérivations. |
| `apps/web/public/brand/arcompt-mark-128.png` | Image servie par le composant React. |
| `apps/web/components/brand/BrandMark.tsx` | `BRAND_MARK_PATH`, `BrandMark`, `BrandTile`, `BrandLockup`. |
| `apps/web/tailwind.config.ts` | Jetons `brand`, `brand-petrol`, `brand-teal`, `brand-light`. |
| `apps/web/public/favicon.ico` | Trames 16 / 32 / 48 sur plaque blanche. |
| `apps/web/public/icon-{192,512}.png`, `icon-maskable-512.png`, `apple-touch-icon.png` | Icônes PWA et iOS. |
| `apps/web/app/manifest.ts`, `apps/web/app/layout.tsx` | Déclaration des icônes. |
| `apps/web/public/offline.html` | Page hors ligne : marque en data URI (préchargée seule, aucune requête possible). |
| `packages/render/src/html.ts` | `MARK_PNG_DATA_URI` au pied des gabarits PDF. |

> **`BRAND_MARK_PATH` a changé de sens.** Il désignait un tracé SVG ; il désigne
> maintenant le **chemin du fichier image**. Le nom est conservé pour ne casser
> aucun import, mais ce n'est plus une chaîne `d=`.

### Recopies à tenir à jour

Le logo est embarqué **en data URI** à deux endroits qui ne peuvent pas faire de
requête : `packages/render/src/html.ts` (Chromium isolé, sans réseau) et
`apps/web/public/offline.html` (page préchargée seule par le service worker).
Les deux portent un PNG 64 × 64 en palette 16 couleurs, 868 octets. **Toute
retouche du logo impose de régénérer ces deux chaînes** depuis
`arcompt-mark-512.png`.

---

## Le pied de page PDF

Le pied des gabarits imprimés porte la marque à **7 pt** (≈ 2,47 mm). Rendu et
regardé dans le Chromium du produit :

- **Sur un écran, à 100 %**, la marque se réduit à un galet coloré. On voit qu'il
  y a quelque chose, on ne voit pas quoi. C'est le même constat qu'à 16 px.
- **À la résolution d'un tirage** (rendu à 8×, soit ≈ 770 ppp), elle reprend
  corps : les barres, le bloc de la calculatrice et le balayage se distinguent.
  Le PNG embarqué fait 64 px pour 2,47 mm, soit ≈ 660 ppp de données : l'image
  n'est pas le facteur limitant.
- **En noir et blanc**, elle redevient une tache grise. Un tirage laser
  monochrome d'une liasse ne montrera qu'un point sombre à côté du mot.

La marque a donc été conservée au pied — elle tient sur le support qui compte,
le papier — mais **elle ne porte aucune information** : c'est « ARCOMPT » écrit à
côté qui identifie le logiciel producteur, et c'est ce texte qui doit rester.

Contrairement à l'ancienne marque, le logo **n'hérite plus du gris `#666`** du
pied via `currentColor` : il y introduit une petite note de couleur qui n'y était
pas. C'est volontaire et assumé, faute d'alternative pour une image matricielle.

---

## Note sur l'emprunt culturel *(conservée)*

Cette section précède le logo actuel. Elle documente une voie explorée puis
écartée lors d'une recherche d'identité antérieure, et **la règle qu'elle a
produite reste valable** pour quiconque reprendra le sujet.

Une piste avait été dessinée à partir de la **grammaire de construction** des
étoffes et des tampons d'Afrique de l'Ouest (trame en losanges, trait d'épaisseur
constante, symétrie bilatérale, forme close sur un champ carré) — et **non** d'un
symbole nommé.

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

## Provenance et licence — à vérifier

**Fait à vérifier avant tout dépôt de marque : la provenance et la licence du
fichier fourni ne sont pas établies dans ce dépôt.** Le JPEG a été reçu tel quel,
sans auteur, sans contrat de cession, sans mention de licence, et sans fichier
vectoriel d'origine. Le style du dessin est courant sur les banques d'images et
les places de marché de logos, où les licences vont de la cession pleine à la
licence non exclusive qui interdit explicitement le dépôt à titre de marque.

Ce qu'il faut réunir, côté propriétaire :

- le nom de l'auteur ou du vendeur, et la facture ou le contrat ;
- la portée exacte de la licence : exclusivité, droit de dépôt à titre de marque,
  droit de modification, territoire, durée ;
- le fichier vectoriel d'origine (AI, EPS ou SVG), s'il existe.

Tant que ces trois points ne sont pas réunis, le logo est employé dans le produit
mais **son dépôt à l'OAPI ou ailleurs n'est pas préparé.**

---

## À reconsidérer

- **Faire vectoriser le logo.** Toutes les limites décrites ici — taille minimale
  de 48 px, favicon sur plaque, data URI recopiés à deux endroits, dimensions
  explicites obligatoires — viennent du fait que la marque est une image. Un SVG
  fourni par l'auteur les lèverait toutes d'un coup, et permettrait une variante
  monochrome propre pour l'impression noir et blanc.
- **Le glyphe des petites tailles.** Voir « Lisibilité en petit ». Rien ne rendra
  ce dessin lisible à 16 px ; seule une forme simplifiée, dérivée d'un élément du
  logo, le ferait. Décision d'identité, non prise ici.
- **Le marine `#1a3a5c` des gabarits PDF.** Il précède cette identité — et il se
  trouve qu'il est **presque le marine du logo** (`#14324E`). Les aligner
  unifierait la marque à peu de frais, mais modifierait l'aspect de liasses que
  des utilisateurs impriment et déposent déjà. Décision volontairement non prise.
- **Le logo et l'interface.** La palette est déclarée dans Tailwind mais
  l'interface reste en `slate` : seuls la marque et la pastille emploient ces
  teintes. Passer les boutons primaires au marine est un second chantier, à mener
  écran par écran.
- **Le nom sous la marque.** Le logotype ne porte pas de signature
  (« La comptabilité intelligente des PME de l'espace OHADA »). Elle existe comme
  texte dans l'application ; en faire un élément verrouillé du logotype est à
  décider avant tout dépôt de marque.
