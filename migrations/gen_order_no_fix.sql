-- gen_order_no: derive the next running number from the numbers already used that IST day, not from
-- count(*) over a day boundary compared in the wrong time zone.
--
-- Before: `placed_at >= (now() AT TIME ZONE 'Asia/Kolkata')::date` compared a timestamptz with the IST *date* read as
-- midnight in the session time zone (UTC), so between 00:00 and 05:30 IST no order of the day was counted and the second
-- order of the night was given the first one's number (-> 409 "Duplicate order"). count(*)+1 also repeats a number
-- when two orders are created at the same moment; the API now retries with the next free number as well
-- (services/distribution/orderNumber.ts), this removes the cause.
--
-- Safe to re-run (CREATE OR REPLACE, same signature).
CREATE OR REPLACE FUNCTION public.gen_order_no(p_org uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    v_date_part text := to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYMMDD');
    v_prefix    text := 'ORD-' || to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYMMDD') || '-';
    v_seq       int;
BEGIN
    SELECT COALESCE(MAX(substring(order_no FROM char_length(v_prefix) + 1)::int), 0) + 1 INTO v_seq
    FROM public.orders
    WHERE org_id = p_org
      AND order_no LIKE v_prefix || '%'
      AND substring(order_no FROM char_length(v_prefix) + 1) ~ '^[0-9]+$';
    RETURN v_prefix || lpad(v_seq::text, 5, '0');
END;
$$;

NOTIFY pgrst, 'reload schema';
