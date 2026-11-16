-- Dealer-direct ordering (e.g. Solar Seeds): an order may target a distributor
-- (dealer) with no retail outlet. The dealer is the customer; pricing resolves
-- straight from the distributor's customer_class/region. So orders.outlet_id must
-- be nullable. Additive and idempotent; Kinematic tenant only (Tata always sends
-- an outlet_id, so its order rows are unaffected).
--
-- Applied to RDS kinematic-mumbai-test, database `kinematic`, on 2026-11-16 via a
-- one-off Fargate psql task (see Kinematic/CLAUDE.md "Running SQL / migrations").
ALTER TABLE public.orders ALTER COLUMN outlet_id DROP NOT NULL;

-- PostgREST caches the schema; reload it after DDL.
NOTIFY pgrst, 'reload schema';
