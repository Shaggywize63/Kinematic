# Security & VAPT runbook

> Last review: 2026-05-03 — security advisor swept, hardening batch applied.
> Owner: ops@kaiyolabs (placeholder — update to a real distribution alias).

This document captures the security posture of the Kinematic platform: what
controls are in place, what remains open, and how to respond when something
goes wrong.

## Reporting a vulnerability

Email `s@kinematicapp.com` with the subject **`[security] <one-line summary>`**.
Please include reproduction steps and (if known) the affected endpoint or
table. We acknowledge within 1 business day. Do **not** open public GitHub
issues for security reports.

## Threat model — what we defend against

| Adversary | Capability | Primary mitigation |
|---|---|---|
| Curious end-user | Browser dev-tools, can replay any call they witnessed | Idempotency keys, server-authoritative pricing, audit log |
| Malicious FE / distributor staff | Has a valid login + mobile app build | Per-role module gates, salesman caps, geofence flags, double-entry ledger trigger |
| Stolen mobile device | Full access to the app + cached tokens | Re-auth on 401 chain; queue scoped per user-key (last 24 of token) so logout doesn't leak |
| Internet attacker | Anonymous; might have phished a low-privilege token | RLS on every public table; SECURITY DEFINER privileges revoked from anon; CORS allowlist; rate limits |
| Compromised distributor laptop | Cookie/token theft; CSRF | strict CORS, `SameSite=Lax` cookies (where used), strict JSON content-type for mutations |
| Inside attacker (DB) | Direct SQL access via a leaked service-role key | `audit_log` is append-only via RLS; `enforce_no_negative_balance` trigger logs admin overrides; idempotency key replays are blocked |

## Controls in place (May 2026)

### Database (Supabase)
- ✅ **RLS enabled** on 45 public tables (every distribution table, audit_log,
  idempotency_keys, plus 22 legacy tables). Backend uses service-role and
  bypasses; anon and authenticated paths are denied by default.
- ✅ **`audit_log` policy fixed** — was `WITH CHECK (true)`, now scoped to
  `auth.jwt() ->> 'org_id'`.
- ✅ **`exec_sql` and `exec_migration` REVOKED + DROPPED** — these were
  anon-callable `SECURITY DEFINER` functions exposing arbitrary SQL via
  `/rest/v1/rpc/exec_sql`. Critical fix.
- ✅ **`SET search_path = ''`** on 21 SECURITY DEFINER functions (anti
  search-path-hijack).
- ✅ **`SECURITY DEFINER` views converted to `SECURITY INVOKER`**
  (`v_daily_kpis`, `v_route_outlet_detail`, `v_route_plan_daily`,
  `v_today_attendance`).
- ✅ **EXECUTE revoked from `anon`** on `current_user_*`, `is_admin_or_above`,
  `is_supervisor_or_above`, `increment_broadcast_read_count`.
- ✅ **Double-entry ledger trigger** refuses any post that pushes
  `running_balance > credit_limit` unless poster is admin-class.
- ✅ **Distribution Storage bucket** is **private** with 10MB cap and
  `image/jpeg | png | webp | heic | application/pdf` mime allowlist.
  Path-scoped RLS: `org/<org_id>/distribution/<kind>/<uuid>.<ext>`.

### API (Express on Railway)
- ✅ **CORS allowlist** — env-driven (`CORS_ORIGINS`); no more
  `cb(null, true)`. Vercel previews opt-in via `CORS_ALLOW_VERCEL_PREVIEWS=true`.
- ✅ **Strict helmet config** — CSP (default-src 'self'; frame-ancestors
  'none'), HSTS preload (`max-age=31536000; includeSubDomains; preload`),
  X-Content-Type-Options nosniff, frameguard deny, referrer-policy
  no-referrer, COOP same-origin.
- ✅ **Per-route rate limits** — auth endpoints (30/min), GSTIN verify
  (30/min), uploads/sign (60/min), salesman API (120/min). Login uses a
  composite (IP + email) limiter (10 attempts / 15 min) so distributed
  brute-force across IPs is throttled.
- ✅ **Idempotency middleware** on every distribution mutation; same key +
  different body → 409.
- ✅ **`Idempotency-Key` header replay protection**, 24h TTL.
- ✅ **Body cap tightened** to 2 MB (was 10 MB); urlencoded to 256 KB.
  Strict JSON content-type for all mutating routes.
- ✅ **Prototype-pollution guard** — request bodies containing `__proto__`,
  `constructor`, `prototype` keys are rejected with HTTP 400.
- ✅ **Server timeouts** — `keepAliveTimeout=65s`, `headersTimeout=70s`,
  `requestTimeout=30s`, `socket.timeout=30s` (slowloris).
- ✅ **Sanitised error responses** — no stacks, no SQL state, no echoed body
  to client. Server-side log lines redact `password`, `token`, `secret`
  values from req.body in logs. Every response carries an `X-Request-Id`.
- ✅ **Password policy** on `createUser` and password-update paths: ≥10
  chars, must contain digit + alpha, no 3+ repeated chars, no obvious
  sequences (`123`, `abc`, `qwerty`), reject top-50 most common.
- ✅ **Audit log** for every order, invoice, payment, return, scheme,
  brand/distributor mutation; immutable (RLS forbids UPDATE/DELETE).
- ✅ **Cheque integrity** — `cheque_image_url` URL must come from our
  `/uploads/sign` flow (path-prefix + bucket validator).
- ✅ **GPS + geofence** flag on every order/payment/return.
- ✅ **Role-based monetary caps** — `salesman_ext.daily_order_cap_value`,
  `daily_collection_cap`, `single_order_cap_value`,
  `return_threshold_value` enforced cumulatively per day.

### Infrastructure
- ✅ **TLS** — Railway terminates TLS 1.2+ at the edge; HSTS preload header
  set.
- ✅ **Secrets** — moved out of code; `.env`-driven via Railway dashboard.
  ⚠️ Dockerfile still passes Supabase keys as `ARG`/`ENV` (build-args);
  see *Open items* below.

## Open items (review before pen-test)

| # | Item | Severity | Owner | Notes |
|---|---|---|---|---|
| 1 | **HIBP password check (HaveIBeenPwned)** | Medium | Ops | Not enabled in Supabase Auth dashboard. Toggle on at Auth → Settings → Password Protection. |
| 2 | **Dockerfile build-args leak Supabase keys** | Medium | DevOps | The Railway-generated Dockerfile uses `ARG SUPABASE_*` + `ENV SUPABASE_*=$SUPABASE_*`, baking secrets into the image. Move to runtime env injection only. |
| 3 | **`kinematic-selfies` and `kinematic-form-photos` are public buckets** | Medium | Backend | Selfies should be private at minimum. Flipping the public flag will break existing dashboard image displays — needs a coordinated cutover (sign URLs server-side or proxy through the API). |
| 4 | **Planogram tables: RLS enabled, no policies** | Low | Backend | Currently denies all anon/authenticated reads; backend service-role works. Add explicit policies if/when those tables need anon read access. |
| 5 | **Refresh-token rotation** | Medium | Auth | Currently relies on Supabase Auth defaults. Verify rotation + revocation on logout in the mobile clients. |
| 6 | **CSP `style-src 'unsafe-inline'`** | Low | Backend | Helmet defaults retain it; the API doesn't serve HTML so it's defence-in-depth only. Tighten when we ever serve a real HTML surface. |
| 7 | **No automated dependency scanner** | Low | DevOps | Set up Dependabot / Renovate + `npm audit --omit=dev` in CI. |
| 8 | **No CI test framework** | Low | Backend | Postman/Newman smoke against staging is the cheapest first step. |
| 9 | **No SBOM** | Low | DevOps | `cyclonedx-bom` per repo. Useful for supply-chain audit. |

## Operations runbook

### Suspected breach — immediate steps
1. **Rotate the Supabase service-role key** (Supabase dashboard → Project
   Settings → API → Generate new). Update Railway env var; redeploy.
2. **Rotate Supabase JWT secret** if user tokens may be compromised. Forces
   global re-login.
3. **Audit `audit_log`** for the suspect time window:
   ```sql
   SELECT actor_user_id, action, entity_table, entity_id, ip_address, user_agent, created_at
   FROM public.audit_log
   WHERE created_at BETWEEN '<from>' AND '<to>'
   ORDER BY created_at DESC;
   ```
4. **Audit `idempotency_keys`** for replay attempts:
   ```sql
   SELECT key, route, request_hash, response_status, COUNT(*)
   FROM public.idempotency_keys
   GROUP BY 1,2,3,4 HAVING COUNT(*) > 1;
   ```
5. **Check ledger reconciliation** for any unauthorised admin overrides:
   ```sql
   SELECT * FROM public.ledger_entries
   WHERE entry_type='adjustment' AND posted_by_role IN ('super_admin','admin','main_admin')
   ORDER BY posted_at DESC LIMIT 100;
   ```
6. **Lock the affected user(s)**:
   ```sql
   UPDATE public.users SET is_active=false WHERE id IN (...);
   ```
   Force-revoke tokens via Supabase Auth → Users → revoke session.

### Routine
- **Weekly**: run the Supabase security advisor (`get_advisors type=security`)
  and address any new ERROR-level findings within 7 days.
- **Quarterly**: run a third-party VAPT against staging. Findings tracked in
  the Open items table above.
- **Per release**: review the diff against the controls list above. Any
  change that touches the Express middleware chain, an RLS policy, a
  SECURITY DEFINER function, or the auth controller requires a second
  reviewer with security context.

## Pen-test acceptance checklist (give to the testers)

```
Scope:
  - https://kinematic-production.up.railway.app/api/v1/*    (backend)
  - https://kinematic-dashboard.vercel.app                   (web)
  - Android + iOS apps (current Play / TestFlight builds)

Out of scope:
  - DDoS / volumetric tests against Railway / Vercel / Supabase shared
    infra. Notify s@kinematicapp.com 48h before any rate-test.
  - Phishing of named employees.

Allowed payloads:
  - All OWASP Top 10 (A01–A10:2021).
  - GraphQL introspection: N/A (REST only).
  - SSRF: every URL field is validated against our signed-upload bucket
    prefix; please confirm no other URL fields are dereferenced.
  - File-upload exploits: confirm mime allowlist (image/jpeg, png, webp,
    heic, application/pdf), 10 MB cap, distribution bucket scoped to
    org/<org_id>/distribution/<kind>/<uuid>.

Reporting:
  - Findings → s@kinematicapp.com with severity (CVSS v3.1) +
    reproduction steps + suggested fix. Coordinated disclosure standard
    is 90 days.
```

## Quick reference — env vars that must be set

| Var | Sensitivity | Owner |
|---|---|---|
| `SUPABASE_URL` | low | Ops |
| `SUPABASE_ANON_KEY` | low | Ops |
| `SUPABASE_SERVICE_ROLE_KEY` | **CRITICAL** | Ops |
| `SUPABASE_JWT_SECRET` | **CRITICAL** | Ops |
| `CORS_ORIGINS` | low | Ops (comma-separated) |
| `CORS_ALLOW_VERCEL_PREVIEWS` | low | `true` for staging only |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` | low | Tuneable |
| `GSTIN_VERIFY_PROVIDER`, `GSTIN_VERIFY_API_KEY` | medium | Optional |
| `EINVOICE_GSP_URL`, `EWAY_GSP_URL` | medium | Optional |
| `ANTHROPIC_API_KEY` | high | AI features |

## Change log

- **2026-05-03** — Initial VAPT hardening pass. 97 advisor findings reduced
  to ~6 known low-severity items. Drop of `exec_sql`/`exec_migration`,
  RLS enabled on 45 tables, helmet/CORS hardened, password policy in,
  Storage `distribution` bucket private, slowloris timeouts.
