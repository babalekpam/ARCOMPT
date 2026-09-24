-- SECURITY DEFINER hardening for the journal balance trigger.  Keep the
-- balance semantics from 0001_core.sql, but never resolve ledger relations
-- through a caller-controlled search_path.

CREATE OR REPLACE FUNCTION public.journal_entry_update_balances() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status = 'VALIDATED' AND (TG_OP = 'INSERT' OR OLD.status = 'DRAFT') THEN
    INSERT INTO public.account_balance (tenant_id, account_id, period_id, debit, credit)
      SELECT NEW.tenant_id, l.account_id, NEW.period_id, sum(l.debit), sum(l.credit)
        FROM public.journal_line l WHERE l.entry_id = NEW.id
        GROUP BY l.account_id
    ON CONFLICT (tenant_id, account_id, period_id) DO UPDATE
      SET debit = public.account_balance.debit + EXCLUDED.debit,
          credit = public.account_balance.credit + EXCLUDED.credit;
  END IF;
  RETURN NULL;
END $$;

-- The trigger invokes this function internally; callers must not be able to
-- execute it directly (including the application group role).
REVOKE ALL ON FUNCTION public.journal_entry_update_balances() FROM PUBLIC, arcompt_app;