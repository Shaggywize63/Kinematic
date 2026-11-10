# Backend test suite

Integration + end-to-end tests for the Kinematic Express/TypeScript API.

## Running

```bash
npm test           # run everything
npm run test:watch # watch mode
npm run test:ci    # CI mode (--runInBand)
npx jest tests/crud.service.test.ts   # a single file
```

No live Supabase, network, or secrets are required. `tests/setupEnv.ts` sets
placeholder Supabase env vars (the app asserts them at boot) before any import.

## Layout

| File | Layer | What it covers |
| --- | --- | --- |
| `crud.service.test.ts` | Data access | The generic CRM CRUD helper driven against a chainable Supabase double — org scoping, soft-delete, **strict vs. shared** client scoping, "any non-reserved query key becomes `.eq()`", the empty-`visibleOwnerIds` short-circuit, pagination clamps, audit-stamp rules, and the 404/500 `AppError` mapping. Asserts on both the returned rows **and the query the helper built**. |
| `leads.service.test.ts` | Service (business logic) | The real `listLeadsWithCount` / `listStuckLeads` query-building — the combined **city / owner / hierarchy** visibility OR, the `ownOnly` short-circuit, the null-city rule under hierarchy, strict-vs-shared client scoping, every column filter, sanitised search, whitelisted sort, and pagination. This is the "wire both ends" logic the demo-token E2E path can't reach (it serves fixtures, not the service). |
| `tenancy.test.ts` | Unit | `getClientScope` / `getClientId` / `isSuperAdmin` precedence (JWT-pinned client → `X-Client-Id` header → none), including malformed-UUID rejection. |
| `validators.test.ts` | Unit | The Zod request validators — a lead needs ≥1 name part, 10-digit phone, deal amount/currency defaults, activity-must-link-to-a-parent, etc. |
| `crmLeadsPlusAnalytics.test.ts` | Service (arithmetic + scoping) | The Lead Management "plus" analytics (`analytics-leads-plus.service.ts`): source performance, follow-up compliance, owner workload / SLA, stage velocity, activity mix, conversion time, weighted pipeline, deal size, win-rate trend, call connect trend, lead recycling. Driven against in-memory tables that **apply** the recorded filters (`helpers/crmPlusFake.ts`), so exact numbers, "another org / client / soft-deleted rows never appear", the caller's visibility scope, bad input (400) and empty orgs are all asserted. |
| `crmLeadsPlusAnalyticsRoutes.test.ts` | HTTP (real router + real rbac gate) | The same endpoints through the CRM router: `{ success, data }` envelope + keys on an empty org, the `crm_lead_analytics` module gate (403 and no query run), 400s, org / client taken from the token, and the cache key (every query param + the scope signature). |
| `crmAnalyticsReportsPlus.test.ts` | Service | The extra data points added to the EXISTING reports (Team Performance, Lead Tracker, Win/Loss, Sales Cycle, Forecast, Lead Source ROI, Team Daily) while their original fields keep their values. |
| `crmAnalyticsPlusHelpers.test.ts` | Unit | Window resolution (date-only `to` includes the whole day), validators, median / percentile, bucketing, call-outcome rules. |
| `crmReportDigestsPlus.test.ts` | Service | The plus reports are available as scheduled email digests. |
| `app.e2e.test.ts` | HTTP E2E | The real Express app via supertest through the full middleware stack (`requireAuth` → `requireModule('crm')` → success-envelope wrapper → demo fixtures), authenticated with the demo-token bypass. Verifies auth gating, routing, the `{ success, data }` envelope + pagination, and read/write semantics. |

## How the Supabase seam is mocked

Every service reads through the single `supabaseAdmin` export in
`src/lib/supabase.ts`. `tests/helpers/supabaseMock.ts` is a faithful,
chainable PostgREST-style builder double: it records every `.eq()/.is()/.or()/
.range()/…` call and resolves (awaited or `.single()`) to a response the test
queued per table. That lets data-layer tests assert the exact query built
(tenant scoping, soft-delete) without a database.

`jose` (ESM-only) is mapped to `tests/helpers/joseStub.ts` for the CJS Jest
runtime — no test exercises real JWT crypto because the HTTP E2E path uses the
demo-token bypass.

## Adding tests

- **A new small resource** (contacts/notes/etc.): it almost certainly flows
  through `crud.service.ts` — add cases there and/or an `app.e2e.test.ts` block.
- **A new pure helper / validator**: add a focused unit file.
- **A new authenticated route**: assert the 401-without-token path and, via the
  demo token, the happy-path envelope shape.
