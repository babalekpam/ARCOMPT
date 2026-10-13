-- 0037 — Catalogue tarifaire v2 (décision commerciale du 2026-10-13) et droits
-- fonctionnels par offre (« features »). Les quotas volumétriques existants
-- (aiCalls / documents / whatsappMessages par dossier et par mois) restent
-- portés par la colonne quotas ; les droits fonctionnels vivent dans la
-- nouvelle colonne features :
--   payroll      : module paie accessible
--   aiAssistant  : assistant IA / capture intelligente accessible
--   whiteLabel   : marque blanche modifiable
--   firmDashboard: tableau de bord cabinet multi-dossiers
--   maxUsers     : sièges (membres) par organisation, null = illimité
--   maxDossiers  : dossiers par organisation, null = illimité (facturé au dossier)
--   trialDays    : durée de l'essai (offre TRIAL uniquement)
-- Le résolveur d'entitlements (apps/api/src/entitlements.ts) lit ces valeurs ;
-- un essai expiré retombe sur les droits de l'offre ESSENTIEL.

ALTER TABLE subscription_plan ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE subscription_plan SET
  label = 'Essai',
  price_per_dossier = 0,
  quotas = '{"aiCalls": 500, "documents": 1000, "whatsappMessages": 300}'::jsonb,
  features = '{"payroll": true, "aiAssistant": true, "whiteLabel": false, "firmDashboard": false, "maxUsers": 5, "maxDossiers": 1, "trialDays": 14}'::jsonb,
  active = true
WHERE code = 'TRIAL';

INSERT INTO subscription_plan (code, label, currency, price_per_dossier, degressive_tiers, pricing_mode, quotas, features) VALUES
  ('ESSENTIEL', 'Essentiel', 'XOF', 9900, '[]'::jsonb, 'VOLUME',
   '{"aiCalls": 100, "documents": 500, "whatsappMessages": 100}'::jsonb,
   '{"payroll": false, "aiAssistant": false, "whiteLabel": false, "firmDashboard": false, "maxUsers": 1, "maxDossiers": null}'::jsonb),
  ('PRO', 'Pro', 'XOF', 24900, '[]'::jsonb, 'VOLUME',
   '{"aiCalls": 500, "documents": 2000, "whatsappMessages": 300}'::jsonb,
   '{"payroll": true, "aiAssistant": true, "whiteLabel": false, "firmDashboard": false, "maxUsers": 5, "maxDossiers": null}'::jsonb)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label, currency = EXCLUDED.currency,
  price_per_dossier = EXCLUDED.price_per_dossier,
  degressive_tiers = EXCLUDED.degressive_tiers, pricing_mode = EXCLUDED.pricing_mode,
  quotas = EXCLUDED.quotas, features = EXCLUDED.features, active = true;

UPDATE subscription_plan SET
  label = 'Cabinet',
  price_per_dossier = 7500,
  degressive_tiers = '[{"upTo": 5, "price": "7500"}, {"upTo": 20, "price": "6500"}, {"upTo": 50, "price": "5500"}, {"price": "4500"}]'::jsonb,
  quotas = '{"aiCalls": 1000, "documents": 5000, "whatsappMessages": 500}'::jsonb,
  features = '{"payroll": true, "aiAssistant": true, "whiteLabel": true, "firmDashboard": true, "maxUsers": 10, "maxDossiers": null}'::jsonb,
  active = true
WHERE code = 'CABINET';

-- Ancienne offre intermédiaire remplacée par ESSENTIEL / PRO.
UPDATE subscription_plan SET active = false WHERE code = 'PME';

-- ---------------------------------------------------------------------------
-- Changement d'offre par l'administration plateforme (mode plateforme actif
-- exigé, vérifié par platform_mode_identity comme platform_overview).
-- Met à jour organization_subscription + organization.plan et journalise le
-- changement dans platform_admin_audit (event ACCESS, avant -> après).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_set_subscription(
  p_sub text, p_sid text, p_token_hash text, p_proof_hash text,
  p_organization_id uuid, p_plan_code text,
  p_started_at date, p_ended_at date, p_price_per_dossier numeric
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $function$
DECLARE
  ident record;
  plan_row public.subscription_plan%ROWTYPE;
  old_plan text;
  new_started date;
BEGIN
  SELECT * INTO ident FROM public.platform_mode_identity(p_sub, p_sid, p_token_hash, p_proof_hash);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Mode plateforme actif requis');
  END IF;
  SELECT * INTO plan_row FROM public.subscription_plan WHERE code = p_plan_code AND active;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_PLAN', 'message', 'Offre inconnue ou inactive');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization WHERE id = p_organization_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Organisation introuvable');
  END IF;
  SELECT coalesce(s.plan_code, o.plan) INTO old_plan
    FROM public.organization o
    LEFT JOIN public.organization_subscription s ON s.organization_id = o.id
    WHERE o.id = p_organization_id;
  new_started := coalesce(p_started_at, current_date);
  INSERT INTO public.organization_subscription
    (organization_id, plan_code, price_per_dossier, started_at, ended_at)
  VALUES (p_organization_id, p_plan_code, p_price_per_dossier, new_started, p_ended_at)
  ON CONFLICT (organization_id) DO UPDATE SET
    plan_code = EXCLUDED.plan_code,
    price_per_dossier = EXCLUDED.price_per_dossier,
    started_at = EXCLUDED.started_at,
    ended_at = EXCLUDED.ended_at,
    updated_at = now();
  UPDATE public.organization SET plan = p_plan_code WHERE id = p_organization_id;
  INSERT INTO public.platform_admin_audit
    (actor_user_id, subject_user_id, organization_id, method, path, event, reason, operator_label)
  VALUES
    (ident.user_id, ident.user_id, p_organization_id, 'PUT',
     '/platform/organizations/subscription', 'ACCESS',
     'Changement d''offre : ' || coalesce(old_plan, 'TRIAL') || ' -> ' || p_plan_code,
     'platform-ui');
  RETURN jsonb_build_object('ok', true, 'organizationId', p_organization_id,
    'planCode', p_plan_code, 'previousPlan', old_plan, 'startedAt', new_started, 'endedAt', p_ended_at);
END;
$function$;
