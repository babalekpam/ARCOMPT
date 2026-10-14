-- SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
-- Migration 0038 — Offre Cabinet : forfait mensuel unique de 75 000 FCFA par
-- cabinet (décision Abel, 2026-10-13), au lieu du tarif dégressif par dossier
-- de 7 500 FCFA, moins cher qu'Essentiel et incohérent sur la page publique.
-- Le forfait couvre dossiers illimités et 10 utilisateurs ; la facturation
-- lit features.billing = 'flat' (montant indépendant du nombre de dossiers).
-- Schéma réel (vérifié en base le 2026-10-13) : le prix vit dans
-- price_per_dossier, sur subscription_plan comme sur organization_subscription,
-- et degressive_tiers est NOT NULL : on le vide avec un tableau JSON vide
-- (le mode flat ignore de toute façon les paliers).

UPDATE subscription_plan
SET price_per_dossier = 75000,
    degressive_tiers = '[]'::jsonb,
    features = features || '{"billing": "flat"}'::jsonb
WHERE code = 'CABINET';

-- Aligne les abonnements Cabinet existants sur le nouveau forfait.
UPDATE organization_subscription SET price_per_dossier = 75000 WHERE plan_code = 'CABINET';

INSERT INTO schema_migration (name) VALUES ('0038_cabinet_flat_pricing')
ON CONFLICT (name) DO NOTHING;
