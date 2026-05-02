-- ============================================================================
-- Distribution Module — Audit log + Idempotency keys
-- ============================================================================
-- audit_log: append-only; UPDATE/DELETE revoked in RLS.
-- idempotency_keys: 24h TTL replay cache for mutating routes.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.audit_log (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid        NOT NULL,
    actor_user_id   uuid        NULL,
    actor_role      text        NULL,
    action          text        NOT NULL,                  -- e.g. 'order.create', 'invoice.cancel'
    entity_table    text        NOT NULL,
    entity_id       uuid        NULL,
    before          jsonb       NULL,
    after           jsonb       NULL,
    metadata        jsonb       NULL,
    ip_address      inet        NULL,
    user_agent      text        NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON public.audit_log (entity_table, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor  ON public.audit_log (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_org    ON public.audit_log (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
    key             text        PRIMARY KEY,
    org_id          uuid        NOT NULL,
    user_id         uuid        NULL,
    route           text        NOT NULL,
    request_hash    text        NOT NULL,
    response_status int         NOT NULL,
    response_body   jsonb       NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);
CREATE INDEX IF NOT EXISTS idx_idempotency_user_route ON public.idempotency_keys (user_id, route);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires    ON public.idempotency_keys (expires_at);

-- ── Audit log immutability ──────────────────────────────────────────────────
-- Block UPDATE / DELETE on audit_log via a policy. RLS must be enabled.
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_select ON public.audit_log;
CREATE POLICY audit_log_select ON public.audit_log
    FOR SELECT USING (true);

DROP POLICY IF EXISTS audit_log_insert ON public.audit_log;
CREATE POLICY audit_log_insert ON public.audit_log
    FOR INSERT WITH CHECK (true);

-- No UPDATE / DELETE policies = denied for non-superuser roles.
REVOKE UPDATE, DELETE ON public.audit_log FROM PUBLIC;

COMMENT ON TABLE public.audit_log         IS 'Append-only audit trail for distribution actions. RLS revokes UPDATE/DELETE.';
COMMENT ON TABLE public.idempotency_keys  IS 'Short-lived replay cache keyed on Idempotency-Key header.';
