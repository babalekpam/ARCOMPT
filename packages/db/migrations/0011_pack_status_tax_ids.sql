-- ARCOMPT — statut du pack pays et chiffrement des identifiants fiscaux (0011)
--
-- Deux sujets, une migration : tous deux portent sur ce qui sort de
-- l'entreprise comme document légal et sur ce que la base laisse voir.
--
-- 1. Statut du pack. `docs/country-packs/README.md` pose depuis l'origine qu'un
--    pack en DRAFT ne produit jamais de déclaration réelle ; la règle n'était
--    écrite qu'en prose. Elle est désormais appliquée par le code
--    (`packages/country-packs/src/official.ts`). Il reste à en garder la trace
--    au repos : un document produit sous l'échappement de pré-production
--    `ALLOW_INSECURE_DRAFT_PACK_FILINGS=1` est marqué non officiel en base, pas
--    seulement dans la réponse HTTP. Les lignes existantes sont réputées
--    officielles (`DEFAULT true`) : aucune n'a pu être produite autrement, le
--    refus n'existait pas.
--
-- 2. Identifiants fiscaux. `company.tax_ids` (jsonb), `partner.tax_id` et
--    `employee.tax_id` étaient en clair alors que docs/SECURITY.md §7 promet un
--    chiffrement applicatif à côté de la paie. Cette migration ajoute les
--    colonnes chiffrées ; elle ne chiffre rien, une migration ne détient pas la
--    clé maître. Le re-chiffrement des lignes existantes est fait par
--    `scripts/encrypt-tax-ids.mts`, idempotent et rejouable.
--
--    Les colonnes en clair sont conservées ici, vidées par le script. Les
--    supprimer dans la même migration rendait impossible tout retour arrière
--    entre le déploiement du schéma et le passage du script ; leur suppression
--    est une migration ultérieure, une fois le script passé partout.

-- ---------------------------------------------------------------------------
-- 1. Marque « document non officiel » sur les artefacts produits depuis un pack
--    non publié.
-- ---------------------------------------------------------------------------
ALTER TABLE tax_return          ADD COLUMN IF NOT EXISTS official boolean NOT NULL DEFAULT true;
ALTER TABLE payroll_declaration ADD COLUMN IF NOT EXISTS official boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN tax_return.official IS
  'Faux si la déclaration a été produite depuis un pack pays non PUBLISHED, sous ALLOW_INSECURE_DRAFT_PACK_FILINGS=1 : document non officiel.';
COMMENT ON COLUMN payroll_declaration.official IS
  'Faux si la déclaration a été produite depuis un pack pays non PUBLISHED, sous ALLOW_INSECURE_DRAFT_PACK_FILINGS=1 : document non officiel.';

-- ---------------------------------------------------------------------------
-- 2. Identifiants fiscaux chiffrés (AES-256-GCM, clé de données du dossier dans
--    payroll_tenant_key — packages/db/src/crypto.ts).
-- ---------------------------------------------------------------------------
ALTER TABLE company  ADD COLUMN IF NOT EXISTS tax_ids_enc text;   -- { NCC: "…", RCCM: "…" } chiffré
ALTER TABLE partner  ADD COLUMN IF NOT EXISTS tax_id_enc  text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS tax_id_enc  text;

-- Index aveugle : HMAC-SHA-256 de l'identifiant normalisé sous une clé dérivée
-- de la clé de données du dossier. Il rend la recherche d'un tiers par son
-- identifiant fiscal possible **par égalité seulement** : un chiffré
-- authentifié à IV aléatoire ne se cherche pas au motif. La recherche par
-- fragment (ILIKE '%…%') sur cette colonne disparaît donc, et c'est délibéré —
-- un NCC/NINEA/IFU se saisit en entier. La recherche par nom est inchangée.
ALTER TABLE partner ADD COLUMN IF NOT EXISTS tax_id_bidx text;
CREATE INDEX IF NOT EXISTS partner_tenant_tax_id_bidx ON partner(tenant_id, tax_id_bidx) WHERE tax_id_bidx IS NOT NULL;

COMMENT ON COLUMN company.tax_ids_enc IS 'company.tax_ids chiffré (JSON) ; la colonne en clair est vidée par scripts/encrypt-tax-ids.mts.';
COMMENT ON COLUMN partner.tax_id_enc  IS 'partner.tax_id chiffré ; la colonne en clair est vidée par scripts/encrypt-tax-ids.mts.';
COMMENT ON COLUMN employee.tax_id_enc IS 'employee.tax_id chiffré ; la colonne en clair est vidée par scripts/encrypt-tax-ids.mts.';
COMMENT ON COLUMN partner.tax_id_bidx IS 'Index aveugle déterministe de partner.tax_id (égalité seulement) — packages/db/src/tenant-keys.ts.';

-- Les droits du rôle applicatif suivent la table, rien à accorder de plus :
-- 0001_core.sql et 0005_payroll.sql donnent déjà SELECT/INSERT/UPDATE/DELETE sur
-- company, partner et employee à arcompt_app, et la RLS reste celle de la table.
