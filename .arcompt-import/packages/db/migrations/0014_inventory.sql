-- SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
-- SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
-- ARCOMPT — stocks et inventaire (module stock)
--
-- Méthode retenue : INVENTAIRE INTERMITTENT, celui que pratique la très grande
-- majorité des PME de l'espace OHADA.
--
--   * les achats de l'exercice vont directement en charges (601, 602, 604…) par
--     le module achats : ce schéma ne double jamais cette écriture ;
--   * les mouvements de stock enregistrés ici sont quantitatifs et valorisés,
--     mais NE SONT PAS COMPTABILISÉS : `stock_movement` ne porte aucune écriture.
--     Ils servent au stock théorique, au coût de sortie et à l'écart d'inventaire ;
--   * à la clôture, et à la clôture seulement, deux écritures passent par le
--     moteur d'imputation : annulation du stock initial (603x/73x D à 3xx C)
--     puis constatation du stock final inventorié (3xx D à 603x/73x C).
--
-- L'inventaire permanent (une écriture par mouvement) n'est PAS implémenté ;
-- aucune colonne de ce schéma ne prétend le contraire.
--
-- Montants et quantités : numeric(20,4), lus en chaînes, jamais de flottants.
-- Toute table porte tenant_id, RLS forcée, politique tenant_isolation, droits
-- au rôle arcompt_app. Le grand livre n'est jamais écrit ici : entry_id ne fait
-- que référencer l'écriture posée par Ledger.post().

-- ---------------------------------------------------------------------------
-- Articles stockés
-- ---------------------------------------------------------------------------
-- Un article stocké porte son compte de stock (3xx) et son compte de variation
-- (603x pour les biens achetés, 73x pour les biens produits). Le couple est
-- imposé par la catégorie SYSCOHADA, mais reste saisissable : un dossier peut
-- avoir ouvert des sous-comptes (3111, 60311…).
CREATE TABLE stock_article (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  code                       text NOT NULL,
  label                      text NOT NULL,
  -- Unité de mesure : sac, kg, litre, u… Libre, jamais interprétée par le code.
  unit                       text NOT NULL DEFAULT 'u',
  category                   text NOT NULL
                             CHECK (category IN ('MARCHANDISE',        -- 31 → 6031
                                                 'MATIERE_PREMIERE',   -- 32 → 6032
                                                 'AUTRE_APPRO',        -- 33 → 6033
                                                 'EN_COURS',           -- 34/35 → 734/735
                                                 'PRODUIT_FINI',       -- 36 → 736
                                                 'PRODUIT_INTERMEDIAIRE')), -- 37 → 737
  -- Compte de stock (classe 3) et compte de variation (6031–6033 ou 734–737).
  stock_account_number       text NOT NULL CHECK (stock_account_number ~ '^3[1-8][0-9]{0,11}$'),
  variation_account_number   text NOT NULL CHECK (variation_account_number ~ '^(603[1-3]|73[4-7])[0-9]{0,9}$'),
  -- Évaluation : coût unitaire moyen pondéré après chaque entrée (CUMP) ou
  -- premier entré-premier sorti (PEPS/FIFO). Le SYSCOHADA révisé n'admet que
  -- ces deux méthodes pour les biens interchangeables ; le DEPS (LIFO) est
  -- proscrit, et aucune valeur du CHECK ne le permet.
  valuation_method           text NOT NULL DEFAULT 'CUMP' CHECK (valuation_method IN ('CUMP', 'FIFO')),
  -- Article du catalogue de facturation correspondant (facultatif).
  product_id                 uuid REFERENCES product(id) ON DELETE SET NULL,
  active                     boolean NOT NULL DEFAULT true,
  created_by                 uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX stock_article_tenant_idx ON stock_article(tenant_id, active);
CREATE INDEX stock_article_account_idx ON stock_article(tenant_id, stock_account_number);
CREATE TRIGGER stock_article_touch BEFORE UPDATE ON stock_article FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Mouvements de stock
-- ---------------------------------------------------------------------------
-- Une entrée porte sa valeur (coût d'acquisition ou de production). Une sortie
-- ne la porte pas : elle est calculée par la méthode de l'article au moment du
-- rejeu (voir packages/invoicing/src/stock/valuation.ts). `quantity` est
-- toujours strictement positive ; c'est `kind` qui donne le sens.
--
-- `quantity_after` et `value_after` sont un instantané du rejeu, réécrit à
-- chaque insertion : ils se lisent, ils ne font pas foi. La vérité est la suite
-- ordonnée des mouvements.
CREATE TABLE stock_movement (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  article_id      uuid NOT NULL REFERENCES stock_article(id) ON DELETE CASCADE,
  -- Ordre de rejeu : (movement_date, seq). Deux mouvements du même jour sont
  -- rejoués dans leur ordre de saisie, jamais dans un ordre arbitraire.
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  movement_date   date NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('OPENING', 'IN', 'OUT')),
  reason          text NOT NULL DEFAULT 'OTHER'
                  CHECK (reason IN ('OPENING', 'PURCHASE', 'PRODUCTION', 'RETURN_IN',
                                    'SALE', 'CONSUMPTION', 'LOSS', 'RETURN_OUT', 'COUNT_ADJUSTMENT', 'OTHER')),
  quantity        numeric(20,4) NOT NULL CHECK (quantity > 0),
  -- Coût unitaire saisi pour une entrée (facultatif : la valeur peut être
  -- donnée directement). Toujours NULL sur une sortie.
  unit_cost       numeric(20,4) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  -- Valeur du mouvement dans la devise du dossier. Sur une entrée, elle est
  -- saisie ; sur une sortie, elle est calculée puis stockée.
  value           numeric(20,4) NOT NULL CHECK (value >= 0),
  quantity_after  numeric(20,4) NOT NULL CHECK (quantity_after >= 0),
  value_after     numeric(20,4) NOT NULL CHECK (value_after >= 0),
  reference       text,
  note            text,
  -- Pièces d'origine, quand le mouvement en vient. Facultatives.
  purchase_document_id uuid REFERENCES purchase_document(id) ON DELETE SET NULL,
  sales_document_id    uuid REFERENCES sales_document(id) ON DELETE SET NULL,
  stock_count_id  uuid,   -- régularisation d'inventaire (FK posée plus bas)
  -- En inventaire intermittent ce champ reste NULL : un mouvement de stock ne
  -- se comptabilise pas. Il existe pour qu'un inventaire permanent, s'il est un
  -- jour construit, y rattache son écriture sans migration de reprise.
  entry_id        uuid REFERENCES journal_entry(id),
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'OUT' OR unit_cost IS NULL)
);
CREATE INDEX stock_movement_replay_idx ON stock_movement(tenant_id, article_id, movement_date, seq);
CREATE INDEX stock_movement_date_idx ON stock_movement(tenant_id, movement_date);

-- ---------------------------------------------------------------------------
-- Inventaire physique et sa valorisation
-- ---------------------------------------------------------------------------
CREATE TABLE stock_count (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  fiscal_year_id  uuid NOT NULL REFERENCES fiscal_year(id),
  count_date      date NOT NULL,
  label           text NOT NULL,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'VALIDATED')),
  -- Somme des lignes, recalculée à la validation ; jamais saisie.
  total_value     numeric(20,4) NOT NULL DEFAULT 0 CHECK (total_value >= 0),
  -- Une régularisation aligne le stock théorique sur le comptage en écrivant
  -- des mouvements d'ajustement. Facultative : l'écart peut rester documenté.
  adjusted        boolean NOT NULL DEFAULT false,
  created_by      uuid,
  validated_by    uuid,
  validated_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_count_tenant_idx ON stock_count(tenant_id, count_date);
CREATE TRIGGER stock_count_touch BEFORE UPDATE ON stock_count FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_count_fk FOREIGN KEY (stock_count_id) REFERENCES stock_count(id) ON DELETE SET NULL;

CREATE TABLE stock_count_line (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  count_id               uuid NOT NULL REFERENCES stock_count(id) ON DELETE CASCADE,
  article_id             uuid NOT NULL REFERENCES stock_article(id),
  counted_quantity       numeric(20,4) NOT NULL CHECK (counted_quantity >= 0),
  -- Stock théorique à la date du comptage, et sa valeur : la comparaison des
  -- deux est l'écart d'inventaire, que le comptable doit pouvoir justifier.
  theoretical_quantity   numeric(20,4) NOT NULL DEFAULT 0,
  theoretical_value      numeric(20,4) NOT NULL DEFAULT 0,
  -- Coût unitaire retenu pour valoriser la quantité comptée. Saisi quand
  -- l'article n'a pas d'historique de mouvements (le dossier ne tient que des
  -- inventaires) ; sinon déduit de la méthode d'évaluation de l'article.
  unit_cost              numeric(20,4) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  unit_cost_source       text NOT NULL DEFAULT 'VALUATION' CHECK (unit_cost_source IN ('VALUATION', 'MANUAL')),
  value                  numeric(20,4) NOT NULL DEFAULT 0 CHECK (value >= 0),
  note                   text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (count_id, article_id)
);
CREATE INDEX stock_count_line_tenant_idx ON stock_count_line(tenant_id, count_id);

-- ---------------------------------------------------------------------------
-- Variation de stock de fin d'exercice
-- ---------------------------------------------------------------------------
-- Un exercice n'a qu'une variation de stock : la contrainte d'unicité le dit,
-- de sorte qu'un second appel ne peut pas doubler les 603x.
CREATE TABLE stock_closing (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  fiscal_year_id     uuid NOT NULL REFERENCES fiscal_year(id),
  closing_date       date NOT NULL,
  count_id           uuid REFERENCES stock_count(id),
  -- Écritures produites par le moteur d'imputation ; NULL si le montant
  -- correspondant est nul (pas de stock initial, ou pas de stock final).
  opening_entry_id   uuid REFERENCES journal_entry(id),
  closing_entry_id   uuid REFERENCES journal_entry(id),
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, fiscal_year_id)
);

-- Détail par compte de stock : ce que l'expert-comptable rapproche du grand
-- livre (solde 3xx) et du compte de résultat (solde 603x / 73x).
CREATE TABLE stock_closing_line (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  closing_id                uuid NOT NULL REFERENCES stock_closing(id) ON DELETE CASCADE,
  stock_account_number      text NOT NULL,
  variation_account_number  text NOT NULL,
  -- Stock initial : solde débiteur du compte 3xx avant la clôture (à-nouveaux).
  opening_value             numeric(20,4) NOT NULL CHECK (opening_value >= 0),
  -- Stock final : valorisation de l'inventaire physique.
  closing_value             numeric(20,4) NOT NULL CHECK (closing_value >= 0),
  -- closing_value − opening_value : le sens du poste RB / RD / RF / TE.
  variation                 numeric(20,4) NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (closing_id, stock_account_number)
);
CREATE INDEX stock_closing_line_tenant_idx ON stock_closing_line(tenant_id, closing_id);

-- ---------------------------------------------------------------------------
-- Row-Level Security et droits
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_article', 'stock_movement', 'stock_count', 'stock_count_line', 'stock_closing', 'stock_closing_line'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO arcompt_app', t);
  END LOOP;
END $$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO arcompt_app;
