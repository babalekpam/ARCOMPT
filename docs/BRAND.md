# Identité visuelle ARCOMPT

ARCOMPT est un logiciel de comptabilité destiné aux PME et aux cabinets d'expertise
comptable de l'espace OHADA. L'identité doit inspirer la même confiance qu'un
registre relié : sobre, stable, lisible sur un téléphone Android d'entrée de gamme
comme sur une liasse imprimée.

**La marque est le monogramme « Concept B », dessiné pour le produit et approuvé
par le propriétaire le 2026-11-12.** Ce document décrit ce logo, ce qu'on en
dérive et ce qu'on n'en fait pas. Il ne propose pas de piste alternative : le
choix est fait en amont, hors du code.

---

## La marque

> La lettre A formée de cinq colonnes de grand livre, de hauteur croissante puis
> décroissante, traversée par une ligne réglée verte et posée sur une ligne de
> base marine encre.

Deux couleurs pleines, aucun dégradé, aucun texte à l'intérieur de la marque.
La colonne centrale et la ligne réglée sont vertes ; les quatre autres colonnes
et la ligne de base sont marine encre. Le fond de la marque est **transparent** :
sur un fond sombre, elle s'emploie dans sa déclinaison pastille, où le glyphe
papier se détache sur une tuile marine encre (voir « Ce qu'on ne fait pas »,
point 4).

### Fichiers source

| Fichier | Rôle |
| --- | --- |
| `apps/web/public/brand/arcompt-mark.svg` | **Master vectoriel** : la marque seule, fond transparent, viewBox 120 × 120. **C'est de ce fichier que tout le reste est dérivé.** |
| `apps/web/public/brand/arcompt-logo.svg` | Logotype horizontal vectoriel : la marque et le nom composés. |
| `apps/web/public/brand/arcompt-tile.svg` | Déclinaison pastille : glyphe papier sur tuile marine encre aux coins arrondis, pour les fonds sombres et les icônes d'application. |
| `apps/web/public/brand/arcompt-mark-512.png` | Rendu matriciel du master, 512 × 512, fond transparent. |
| `apps/web/public/brand/arcompt-mark-128.png` | Même rendu en 128 × 128, servi à l'interface et comme `logoImageUrl` (la pastille ne dépasse jamais 36 px, soit 3,5× de réserve). |
| `apps/web/public/brand/arcompt-logo-source.jpg` | Source de l'ancienne marque, telle que fournie par le propriétaire : JPEG 740 × 740, fond blanc opaque. Conservée pour mémoire, elle ne sert plus de référence. |

La marque est un tracé vectoriel natif : les rendus matriciels se régénèrent
depuis le SVG, à la taille voulue et sans perte. Les contraintes historiques
liées à l'ancienne image matricielle sont levées ; voir « À reconsidérer ».

---

## Palette

Définie par le tracé du monogramme et par la refonte claire du 2026-11-12 : ce
sont les valeurs du dessin et des surfaces qui le portent.

| Rôle | Hex | Emploi |
| --- | --- | --- |
| **Marine encre** (primaire) | `#0F2A43` | Quatre des cinq colonnes et la ligne de base. Teinte dominante, la seule utilisable en texte. |
| **Vert de marque** | `#0E9F6E` | La colonne centrale et la ligne réglée. Accent du dessin. |
| **Papier** | `#FAF6EF` | Le glyphe dans la déclinaison pastille, et le fond clair de référence des pages publiques. |
| **Blanc chaud** | `#FFFDF8` | Les cartes et les surfaces claires qui portent la marque dans l'interface. |

Les neutres restent l'échelle `slate` de Tailwind, déjà employée dans toute
l'interface. Les jetons sont déclarés dans `apps/web/tailwind.config.ts` sous
`brand`, `brand-petrol`, `brand-teal`, `brand-light` : `brand` porte le marine
encre, `brand-teal` et `brand-light` portent le vert. Le jeton `brand-petrol`
est un héritage de l'interface, pas une couleur de la marque.

### Contrastes mesurés (WCAG 2.1)

| Couleur | sur `#FFFFFF` | sur `#FAF6EF` | sur `#0F2A43` |
| --- | --- | --- | --- |
| Marine encre `#0F2A43` | **14.66** | **13.61** | 1.00 |
| Vert `#0E9F6E` | 3.39 | 3.14 | **4.33** |
| Papier `#FAF6EF` | 1.08 | 1.00 | **13.61** |

Lecture : **le logo est une marque de fond clair.** Les colonnes marine encre
tombent sous 1,5:1 sur les fonds sombres de l'échelle `slate` : elles y
disparaissent purement et simplement. Le vert fait l'inverse : il tient sur le
marine encre, pas comme texte sur fond clair.

C'est la raison, et la seule, pour laquelle la pastille (`BrandTile`) reste
**blanche en thème sombre** au lieu d'inverser la marque. Le liseré
`ring-white/20` l'empêche de flotter. Pour porter la marque sur un fond sombre
sans pastille blanche, la déclinaison `arcompt-tile.svg` est la forme prévue :
glyphe papier sur tuile marine encre.

Le vert `#0E9F6E` tient à 3,39:1 sur blanc : assez pour les éléments graphiques
et les grands titres, **jamais pour un texte courant sur fond clair.** Dans la
marque, il ne porte que la colonne centrale et la ligne réglée.

---

## Espacement et tailles minimales

- **Zone de protection** : au moins **1/8 de la largeur de la marque** libre de
  tout texte, filet ou bord, sur les quatre côtés. Dans le logotype, l'écart
  entre la pastille et le nom vaut `0.5rem` (8 px).
- **Pastille** : la marque occupe **≈ 75 %** de la pastille (20 px dans 28,
  24 dans 32, 28 dans 36). Rayon d'angle `rounded-md` à 28 px, `rounded-lg`
  au-delà.
- **Taille minimale utile de la marque seule : 16 px.** Le tracé ne compte que
  cinq colonnes et deux lignes, sans détail fin : il reste lisible aux tailles
  d'icône, voir le constat révisé ci-dessous.
- **Taille minimale du logotype complet** : 28 px de hauteur de pastille.
- **Icône masquable (Android)** : la déclinaison pastille est posée à fond perdu
  sur marine encre, le glyphe tenant dans les 80 % centraux que le masque du
  système laisse voir.
- **Dimensions explicites obligatoires.** Tout `<img>` qui porte la marque
  déclare `width` et `height` (128 × 128) et un `alt`, sans quoi la mise en
  page saute au chargement.

---

## Lisibilité en petit : constat

**Mise à jour du 2026-11-12.** Le constat qui suit portait sur l'ancienne marque
matricielle ; il est conservé comme historique, parce que c'est lui qui a motivé
son remplacement. Le monogramme actuel est le glyphe simplifié que ce constat
réclamait : cinq colonnes et deux lignes, deux couleurs, aucune ligne fine. Le
favicon et les icônes PWA ont été régénérés depuis le tracé vectoriel.

Le favicon de l'ancienne marque avait été rendu à **16, 20, 24 et 32 px**, sur
fond clair et sur fond sombre, puis regardé. Verdict, sans complaisance :

| Taille | Ce qu'on voit réellement |
| --- | --- |
| **16 px** | **Illisible.** Une tache turquoise et marine en diagonale. Le clavier a disparu, les trois barres ont fusionné en un seul plan, les deux rubans n'en font plus qu'un. On ne reconnaît ni calculatrice, ni graphique. |
| **20 px** | **Illisible.** Le ruban inférieur commence à se détacher ; tout le reste reste une bouillie. |
| **24 px** | **Limite.** L'arc des rubans se lit, la silhouette de la calculatrice s'annonce. Le clavier reste une texture grise. |
| **32 px** | **Silhouette lisible, détail perdu.** On identifie « barres + bloc + balayage ». Les neuf touches ne sont toujours pas des touches, seulement un grain. |

L'ancienne marque demandait **≈ 48 px pour être vraiment lue**. C'était le prix
de trois motifs superposés (histogramme, calculatrice, rubans) dans une marque
carrée.

Le fond clair ou sombre ne changeait rien à ce constat : la plaque blanche
isolait le dessin dans les deux cas. Elle était en revanche **indispensable** :
sans elle, les rubans marine s'effaçaient sur une barre d'onglets sombre. C'est
pourquoi le favicon et les icônes PWA de l'ancienne marque portaient une plaque
blanche. La nouvelle marque inverse le principe pour les icônes : le glyphe
papier se détache sur le fond marine encre de la tuile.

**Ce qui a corrigé le problème** : le propriétaire a tranché la décision
d'identité le 2026-11-12. Le monogramme Concept B est ce glyphe simplifié,
dessiné d'emblée pour toutes les tailles : cinq colonnes, deux lignes, deux
couleurs, aucune ligne fine.

---

## Ce qu'on ne fait pas avec la marque

1. **Ne pas la recolorer.** Deux teintes, celles du tracé : marine encre et
   vert. La seule déclinaison prévue est la pastille, glyphe papier sur tuile
   marine encre. Pas d'autre inversion ni de teinte unique improvisée.
2. **Ne pas la déformer.** Jamais d'étirement non uniforme, de rotation,
   d'italique ni de perspective. On met le fichier à l'échelle, rien d'autre.
3. **Ne pas la mettre en dégradé**, ni ombre portée, ni lueur, ni biseau.
4. **Ne pas la poser telle quelle sur un fond sombre ni sur une photo.** Le
   marine encre y disparaît (moins de 1,5:1). Sur fond chargé ou sombre :
   pastille blanche, ou déclinaison `arcompt-tile.svg`, toujours.
5. **Ne pas la réduire sous 16 px.** En dessous, les colonnes fusionnent ; à
   ces tailles, aucune forme de la marque n'est lisible et il faut s'en passer.
6. **Ne pas repartir d'un rendu matriciel.** Toute nouvelle dérivation part du
   master vectoriel `arcompt-mark.svg`.
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
| `apps/web/public/brand/arcompt-mark.svg` | Master vectoriel. Fichier servi par le composant React, source de toutes les dérivations. |
| `apps/web/public/brand/arcompt-logo.svg` | Logotype horizontal vectoriel. |
| `apps/web/public/brand/arcompt-tile.svg` | Déclinaison pastille pour fonds sombres et icônes d'application. |
| `apps/web/public/brand/arcompt-mark-512.png` | Rendu matriciel 512 × 512 du master. |
| `apps/web/public/brand/arcompt-mark-128.png` | Rendu 128 × 128 ; `logoImageUrl` déclaré dans `app/layout.tsx`. |
| `apps/web/public/brand/arcompt-logo-source.jpg` | Source de l'ancienne marque (JPEG 740 × 740, fond blanc), conservée pour mémoire. |
| `apps/web/components/brand/BrandMark.tsx` | `BRAND_MARK_PATH`, `BrandMark`, `BrandTile`, `BrandLockup`. |
| `apps/web/tailwind.config.ts` | Jetons `brand`, `brand-petrol`, `brand-teal`, `brand-light`. |
| `apps/web/public/favicon.ico` | Favicon régénéré depuis la déclinaison pastille. |
| `apps/web/public/icon-{192,512}.png`, `icon-maskable-512.png`, `apple-touch-icon.png` | Icônes PWA et iOS, régénérées depuis le master. |
| `apps/web/app/manifest.ts`, `apps/web/app/layout.tsx` | Déclaration des icônes. |
| `apps/web/public/offline.html` | Page hors ligne : marque en data URI (préchargée seule, aucune requête possible). |
| `packages/render/src/html.ts` | `MARK_PNG_DATA_URI` au pied des gabarits PDF. |

> **`BRAND_MARK_PATH` désigne le chemin du fichier de la marque**, aujourd'hui
> `/brand/arcompt-mark.svg`. Le nom est conservé pour ne casser aucun import ;
> il a désigné un rendu PNG pendant la période de l'ancienne marque
> matricielle.

### Recopies à tenir à jour

Le logo est embarqué **en data URI** à deux endroits qui ne peuvent pas faire de
requête : `packages/render/src/html.ts` (Chromium isolé, sans réseau) et
`apps/web/public/offline.html` (page préchargée seule par le service worker).
Les deux portent un PNG 64 × 64 en palette 16 couleurs, 868 octets, qui est
encore le rendu de l'ancienne marque : la bascule du 2026-11-12 ne les a pas
touchés. **Toute retouche du logo impose de régénérer ces deux chaînes** depuis
le master vectoriel ; cette régénération reste à faire.

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

La marque a donc été conservée au pied, elle tient sur le support qui compte,
le papier, mais **elle ne porte aucune information** : c'est « ARCOMPT » écrit à
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
constante, symétrie bilatérale, forme close sur un champ carré), et **non** d'un
symbole nommé.

Deux symboles adinkra ont été étudiés avant d'écarter cette voie :

- **Fihankra**, la concession close, à entrée unique : sécurité, sûreté,
  solidarité. ([source](https://www.adinkrasymbols.org/symbols/fihankra/))
- **Nsaa**, une étoffe tissée de qualité ; excellence, authenticité, d'après le
  proverbe akan *« Nea onnim nsaa na oto n'ago »*, « qui ne connaît pas le vrai
  nsaa achètera la contrefaçon ».
  ([source](https://www.adinkrasymbols.org/symbols/nsaa/))

Les deux sens conviendraient au produit. **Aucun des deux n'a été reproduit**, pour
deux raisons. D'abord parce que l'adinkra est **akan** (Ghana, et les populations
akan de l'est de la Côte d'Ivoire) et non panafricain : en faire l'emblème d'un
produit qui sert aussi le Sénégal, le Mali, le Cameroun, le Niger, le Bénin, le
Togo et le Burkina reviendrait à présenter la culture d'un seul peuple comme celle
de dix-sept pays. Ensuite parce que déposer un symbole traditionnel comme marque
commerciale, c'est s'approprier un bien qui n'appartient pas à l'entreprise.

**Règle pour la suite** : on peut emprunter une géométrie ; on n'emprunte pas un
nom ni le sens qui va avec. Si une piste adinkra est un jour reprise, elle doit
l'être avec des praticiens de la région, pas depuis une planche de symboles.

---

## Provenance et licence

**La provenance de la marque actuelle est établie.** Le monogramme Concept B a
été dessiné pour ARCOMPT, et le propriétaire l'a approuvé le 2026-11-12 ; ses
fichiers sources sont les SVG du dépôt. Le point de vigilance qui suit
concernait l'ancienne marque et ne s'applique plus qu'à elle.

La provenance et la licence du fichier fourni alors ne sont pas établies dans
ce dépôt. Le JPEG a été reçu tel quel, sans auteur, sans contrat de cession,
sans mention de licence, et sans fichier vectoriel d'origine. Le style du
dessin est courant sur les banques d'images et les places de marché de logos,
où les licences vont de la cession pleine à la licence non exclusive qui
interdit explicitement le dépôt à titre de marque.

Ce qu'il aurait fallu réunir pour cet ancien fichier, côté propriétaire :

- le nom de l'auteur ou du vendeur, et la facture ou le contrat ;
- la portée exacte de la licence : exclusivité, droit de dépôt à titre de marque,
  droit de modification, territoire, durée ;
- le fichier vectoriel d'origine (AI, EPS ou SVG), s'il existe.

Ces trois points ne sont plus un préalable pour la marque actuelle. Ils ne
vaudraient que si l'ancienne marque devait être déposée, ce qui n'est pas le
projet.

---

## À reconsidérer

- **Faire vectoriser le logo : fait.** Le monogramme adopté le 2026-11-12 est un
  tracé SVG natif. Les limites de l'ancienne image (taille minimale de lecture,
  favicon sur plaque, dimensions explicites obligatoires) sont levées ; reste la
  régénération des deux recopies en data URI, voir « Recopies à tenir à jour ».
- **Le glyphe des petites tailles : fait.** Voir « Lisibilité en petit ». Le
  monogramme est ce glyphe simplifié, dessiné pour tenir à 16 px.
- **Le marine `#1a3a5c` des gabarits PDF.** Il précède cette identité, et il se
  trouve qu'il est **presque le marine encre de la marque** (`#0F2A43`). Les
  aligner unifierait la marque à peu de frais, mais modifierait l'aspect de
  liasses que des utilisateurs impriment et déposent déjà. Décision
  volontairement non prise.
- **Le logo et l'interface.** La palette est déclarée dans Tailwind. Les pages
  publiques l'ont adoptée lors de la refonte claire du 2026-11-12 ;
  l'interface applicative reste en `slate`, où seuls la marque et la pastille
  emploient ces teintes. Passer les boutons primaires au marine encre dans
  l'application est un second chantier, à mener écran par écran.
- **Le nom sous la marque.** Le logotype ne porte pas de signature
  (« La comptabilité intelligente des PME de l'espace OHADA »). Elle existe comme
  texte dans l'application ; en faire un élément verrouillé du logotype est à
  décider avant tout dépôt de marque.
