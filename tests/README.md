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
| `tenancy.test.ts` | Unit | `getClientScope` / `getClientId` / `isSuperAdmin` precedence (JWT-pinned client → `X-Client-Id` header → none), including malformed-UUID rejection. |
| `validators.test.ts` | Unit | The Zod request validators — a lead needs ≥1 name part, 10-digit phone, deal amount/currency defaults, activity-must-link-to-a-parent, etc. |
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
