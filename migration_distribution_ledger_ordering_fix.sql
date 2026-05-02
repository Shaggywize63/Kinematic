-- ============================================================================
-- Distribution Ledger — concurrency / ordering fix
-- ============================================================================
-- Two ledger posts that ran inside the same DB transaction shared `now()` and
-- `ORDER BY posted_at DESC LIMIT 1` then picked an arbitrary "previous" row,
-- producing a non-deterministic running_balance.
--
-- Two safeguards applied:
--   1) Default `posted_at` to clock_timestamp() so each insert gets a unique
--      timestamp even within one xact.
--   2) Add a stable tiebreaker (id) when reading the latest row.
-- ============================================================================

ALTER TABLE public.ledger_entries
    ALTER COLUMN posted_at SET DEFAULT clock_timestamp();

CREATE OR REPLACE FUNCTION public.post_ledger_entry(
    p_org           uuid,
    p_client        uuid,
    p_outlet        uuid,
    p_distributor   uuid,
    p_entry_type    text,
    p_ref_table     text,
    p_ref_id        uuid,
    p_dr            numeric,
    p_cr            numeric,
    p_notes         text,
    p_posted_by     uuid,
    p_posted_role   text
) RETURNS public.ledger_entries
LANGUAGE plpgsql
AS $$
DECLARE
    v_prev      numeric;
    v_new       numeric;
    v_row       public.ledger_entries;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext(p_outlet::text));
    SELECT COALESCE(running_balance, 0) INTO v_prev
    FROM public.ledger_entries
    WHERE outlet_id = p_outlet
    ORDER BY posted_at DESC, id DESC LIMIT 1;
    v_new := COALESCE(v_prev, 0) + COALESCE(p_dr, 0) - COALESCE(p_cr, 0);

    INSERT INTO public.ledger_entries (
        org_id, client_id, outlet_id, distributor_id, entry_type,
        ref_table, ref_id, dr, cr, running_balance, notes, posted_at, posted_by, posted_by_role
    ) VALUES (
        p_org, p_client, p_outlet, p_distributor, p_entry_type,
        p_ref_table, p_ref_id, COALESCE(p_dr, 0), COALESCE(p_cr, 0), v_new,
        p_notes, clock_timestamp(), p_posted_by, p_posted_role
    ) RETURNING * INTO v_row;

    UPDATE public.outlet_distribution_ext
    SET current_balance = v_new, updated_at = now()
    WHERE outlet_id = p_outlet;

    RETURN v_row;
END;
$$;
