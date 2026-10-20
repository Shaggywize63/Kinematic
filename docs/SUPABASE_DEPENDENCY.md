# Supabase dependency — where we stand after the move to AWS (2026-10-20)

**Short answer.** Nothing depends on Supabase the *company* any more: no supabase.com project, no hosted Auth/Storage/Edge
Functions/Realtime, no Management API, no pg_cron/pg_net (both databases carry only `citext, pg_trgm, pgcrypto, plpgsql,
uuid-ossp`). What remains is **open-source Supabase components that we run ourselves on ECS**, and the code is written against
their APIs.

## What runs today (per tenant stack: `kinematic-supabase`, `kinematic-supabase-tata`)
| Container | Image | Role | Who talks to it |
|---|---|---|---|
| rest | `postgrest/postgrest:v12.2.3` | REST API over Postgres | backend `supabaseAdmin` (≈2,700 `.from()` calls, 41 `.rpc()`) |
| auth | `supabase/gotrue:v2.196.0` | users, passwords, JWT, refresh tokens, recovery e-mail | backend (23 `auth.admin.*`, 13 user flows), every client via the backend `/auth/*`; mobile apps keep the GoTrue refresh token |
| storage | `supabase/storage-api:v1.71.0` | buckets + signed upload/download URLs (S3 backend) | backend (32 call sites); mobile apps PUT to signed URLs; dashboard uploads selfies with the anon key |
| gateway | `nginx:1.27-alpine` | routes `/rest/v1`, `/auth/v1`, `/storage/v1` | all of the above |

All four share one 0.25 vCPU / 1 GB Fargate task per tenant — thin for the traffic they carry.

## Removed in this change (vendor-cloud remnants, all dormant)
- `src/lib/supabaseManagement.ts` and `src/services/provisionClient.service.ts` — created dedicated projects through
  `api.supabase.com`. `POST /clients/provision` now answers 410 and `GET /clients/provision/preflight` says "not available",
  which is exactly what production already returned (`SUPABASE_MANAGEMENT_TOKEN` was never set on ECS).
- `supabase/functions/*` — nine Deno edge functions that were thin pg_cron → `/api/v1/cron/*` triggers. They are
  superseded by EventBridge Scheduler (`kinematic-cron-*`, 15 schedules) and the in-process schedulers; nothing deploys them.

Still present but harmless: comments and old migration headers that mention the two retired project refs; the dashboard's
`api-proxy` edge fallback (retired, unreachable); `platformProjects.ts` can build a `<ref>.supabase.co` JWKS URL for a
runtime-registered project that has a `project_ref` (none do).

## Found while checking: cron endpoints with no driver on AWS
`POST /cron/leave-carry-forward` and `POST /cron/rescore-planogram-compliance` have neither an EventBridge schedule nor an
in-process timer (they relied on pg_cron). Leave carry-forward is yearly — worth adding a schedule before 1 January.

## Replacing the OSS stack — recommended order, with the user-impact of each step
1. **Pin and mirror the images (low risk, do first).** Copy the four images to ECR by digest; Docker Hub rate limits and tag
   drift are the real operational dependency today. Give the stack more CPU (1 vCPU) before any migration work.
2. **Storage → S3 presigned URLs (medium).** The backend already hands out signed URLs; change the signer to S3 and copy
   objects from the storage-api key layout. Mobile apps just PUT to whatever URL they are given, so no app release is needed.
   Dashboard anon-key uploads move behind a backend-issued URL (also closes a public-write bucket path).
3. **Auth → own service (high, needs a dual-run window).** bcrypt hashes in `auth.users` are portable; the cost is sessions:
   mobile apps hold GoTrue refresh tokens, so the new service must accept them for a full 30-day cycle or every field user
   is logged out once. Replace the e-mail recovery flow with SES/Resend. Do not start before step 1 and a load test.
4. **Data API (highest, optional).** Replace PostgREST with direct SQL (`pg` + a pool/RDS Proxy) behind the existing
   `supabaseAdmin` surface. PostgREST resource embedding (`select('*, users(name)')`) has to be re-implemented, so this is a
   per-module migration, hottest endpoints first. PostgREST is Apache-2/MIT, runs fine on ECS, and nothing forces this step.

Steps 2–4 each change a path every user touches; none is safe to do "in one pass", which is why they are staged and not done here.
