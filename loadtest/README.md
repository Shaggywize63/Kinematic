# Kinematic — Load Tests

k6 scripts targeting the highest-risk read paths in the CRM module. Each
script encodes its own SLO as a `thresholds` block — k6 exits non-zero
when a threshold is violated, so these are CI-friendly.

## Prerequisites

- `k6` installed (`brew install k6` or
  https://k6.io/docs/get-started/installation/)
- A valid Kinematic JWT for the org you want to test against. The dashboard
  stores this in `localStorage.kinematic_token` after login; copy it from
  DevTools.
- Optional: a `client_id` UUID if the test should run scoped to one
  sub-tenant. Without it, the request behaves as an org-level admin
  (sees everything in the org).

```sh
export BASE_URL=https://api.kinematicapp.com
export TOKEN=eyJhbGciOi...                # from localStorage.kinematic_token
export CLIENT_ID=00000000-0000-0000-0000-000000000000  # optional
```

## Scripts

| Script | What it tests | SLO |
|---|---|---|
| `dashboard-complete.js` | The single dashboard payload, both rupee and the new `unit=weight` mode (which adds the line-items × products join). | p95 < 800ms (₹), < 1.5s (weight). errors < 1%. |
| `leads-search.js` | `GET /leads` unfiltered + `GET /leads?q=` (uses the sanitised `.or()` filter, no trigram index). | p95 < 500ms (list), < 800ms (search). errors < 1%. |
| `kini-chat.js` | `POST /ai/chat` with realistic prompts that exercise the tool-use loop. Latency-dominated by Anthropic upstream. | p95 < 15s. errors < 5%. 429s < 10%. |

## Run one

```sh
k6 run loadtest/dashboard-complete.js
```

## Run all

```sh
for f in loadtest/*.js; do
  echo "=== $f ==="
  k6 run "$f" || echo "FAILED: $f"
done
```

## Interpreting failures

- **`http_req_failed > 1%`** — non-2xx responses. Check Railway logs.
- **`p(95) > threshold`** — the endpoint is slower than expected. Most
  likely culprits, in order: missing index, line-items fan-out (weight
  mode), upstream throttling (chat).
- **`rate_limit_hits > 10%` (chat only)** — Anthropic is throttling.
  Either drop concurrency or check whether the org has a per-key quota.

## Notes

- The chat test deliberately runs at a low VU count (5) and adds 2-5s
  jitter between requests — chats are expensive and noisy upstream.
- None of the tests perform mutations. They're safe to point at staging
  or production without leaving residue.
- If you need higher concurrency, raise the `vus` / `target` in the
  `options.scenarios` block. Don't touch the `thresholds` — those are
  the SLOs.

## Adding a new test

1. Pick the endpoint and decide what an acceptable p95 latency looks like.
2. Copy the structure from `dashboard-complete.js`: `headers()` helper,
   `Trend` per logical operation, `Rate('errors')`, scenarios + thresholds.
3. Use `check()` to assert response shape, not just status code — bad
   shape (`success: false`) often returns 200.
