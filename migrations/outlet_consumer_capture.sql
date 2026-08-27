-- Distribution / Consumer Capture — per-outlet self-registration token
--
-- Automates the previously-manual "secondary / consumer sale" capture. Each
-- outlet gets a stable, rotatable capture token; a printed QR code (or a wa.me
-- deep link) built from it opens a public, no-login page where a consumer
-- registers the product they just bought. That registration reuses the existing
-- consumer-registration fan-out (auto-creates a tertiary sale + a CRM lead), so
-- the brand finally sees real sell-through per outlet without anyone keying it.
--
-- `capture_token`  — opaque url-safe secret; the public route resolves the outlet
--                    (and its org/client) from this token alone.
-- `capture_active` — gates whether the outlet's public link accepts submissions,
--                    so a token can be disabled (printed QRs stop working) and
--                    re-activated later WITHOUT rotating/reprinting it.
--
-- Additive + backward-compatible: nothing reads these columns unless the feature
-- is used, so production behaviour for existing tenants is byte-for-byte
-- unchanged until an admin mints tokens.
--
-- Applied to Kinematic (clldjlojtmrrpozydqxk) via apply_migration
-- `outlet_consumer_capture`. Apply the SAME migration to Tata
-- (lnvxqjqfsxvtjvbzphou) before enabling consumer capture for that tenant.

ALTER TABLE public.outlet_distribution_ext
  ADD COLUMN IF NOT EXISTS capture_token  text,
  ADD COLUMN IF NOT EXISTS capture_active boolean NOT NULL DEFAULT false;

-- The token is globally unique so the unauthenticated public route can resolve
-- an outlet from it alone. Partial: only rows that actually carry a token are
-- constrained, so the many token-less outlets don't collide on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_outlet_capture_token
  ON public.outlet_distribution_ext (capture_token)
  WHERE capture_token IS NOT NULL;
