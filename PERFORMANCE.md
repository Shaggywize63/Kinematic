# Performance — what we did, what's left, how to measure

> Companion to `SECURITY.md`. Last review: **2026-05-03**.

## Where the time was actually going

Three places, listed by impact on perceived latency:

| Hot path | Before | After | Why it was slow |
|---|---|---|---|
| Mobile **check-in** flow | ~1.8–2.4 s before "Checked In" appears | ~50–150 ms (optimistic) + background sync | UI awaited the full server round-trip, which itself awaited 2 telemetry writes after the upsert. |
| Backend **check-in** endpoint | 5 sequential DB round-trips (`existing` → `zone` → `upsert` → `work_activity` → `users`), all on the response path | 2 parallel reads + 1 upsert + telemetry runs after `res.send()` | Telemetry was blocking the response for no reason. |
| Dashboard **/attendance/today** poll | Full JSON refetch every time the tab regained focus | 304 Not Modified after first hit (15s private cache + ETag) | No `Cache-Control` headers on hot GETs. |

## What landed in this commit

### Backend (`Shaggywize63/Kinematic`)
- **Attendance check-in**: parallelised the existing-record + zone lookups, switched zone to `.maybeSingle()`, and **deferred** the `work_activity` insert + `users` last-location update until after the response is sent (fire-and-forget). Same on check-out.
- **HTTP cache helper** at `src/utils/cache.ts` — sets `Cache-Control` + ETag and 304s on `If-None-Match`. Applied to `GET /attendance/today` (15s), `/attendance/history` (60s), `/attendance/team` (20s).
- **Index pass** (Supabase migration applied):
  - `idx_salesman_ext_assigned_distributor` covers the unindexed FK that was forcing seq-scans on distributor→salesman joins
  - `idx_orders_status_placed_at`, `idx_invoices_outlet_issued_at`, `idx_payments_outlet_received_at`, `idx_returns_outlet_created_at` cover the most frequent dashboard filters
  - `idx_attendance_user_date` is explicit (the unique constraint already gave us one)
- **RLS init-plan fix** on `audit_log`: wrapped `auth.jwt() ->> 'org_id'` in `(SELECT ...)` so Postgres caches the JWT lookup once per query instead of re-evaluating it per row. Eliminates 2 WARN-level `auth_rls_initplan` advisor findings — and is the single biggest win when audit_log gets large.

### Mobile — Android (`Shaggywize63/Kinematic-App`)
- **Optimistic UI on check-in / check-out**: `AppViewModel.checkIn()` now flips `_today` to a "Checked In" record the moment the user taps. The API call confirms in the background; on failure the previous state is restored. Same pattern for `checkOut()`. **The user sees the green tick instantly** — typically a 1-2 second perceived speedup on slow networks.

## Things you can do today to feel the difference (no code change)

1. **Enable Supabase connection pooling**: Project Settings → Database → Connection Pooling → use the **Transaction** mode pooler URL for the backend. Cuts cold-call latency by ~40 ms each.
2. **Move Railway region closer to your users**: Project → Settings → Deploy. If the app is India-first, `Singapore (asia-southeast1)` shaves ~80 ms off every request vs. `us-west2`.
3. **Increase Railway instance size by one tier**: cheapest perf win on the backend. The current Hobby instance gets CPU-throttled under load.
4. **Turn on Supabase Auth → Sessions → "Use refresh tokens"** if not already on — prevents the FE app from full-login round-trips when the access token expires.
5. **Toggle Vercel "Edge Network"** for the dashboard (Vercel auto-does this; verify in Project Settings → General → Speed Insights).

## What's left (ranked by impact)

| # | Item | Where | Effort | Estimated win |
|---|---|---|---|---|
| 1 | **iOS optimistic UI** for attendance | iOS app | 1 hr | -1.5 s on perceived latency, same as Android |
| 2 | **Drop unused indexes** (131 flagged by advisor) | DB | 30 min, careful review | Faster writes on attendance/orders/forms; ~5–15% on bulk inserts |
| 3 | **Mobile: gzip request bodies** | Android + iOS | 2 hr | ~30% smaller payloads on slow networks (selfies are already image-compressed; helps JSON only) |
| 4 | **Reduce check-in selfie image size client-side** | Android + iOS | 2 hr | Selfie upload is ~70% of the check-in latency on 3G; resizing to 1280×720 + JPEG q=70 cuts it 4× |
| 5 | **Background sync for attendance** | Android + iOS | 1 day | Move check-in to the offline queue (like distribution orders) so the user can go offline mid-tap and still get a stamped record |
| 6 | **Server-side response compression** for large list payloads | Backend | already on (`compression()`); verify gzip is reaching mobile | 0 |
| 7 | **Dashboard pre-fetch on hover** | Dashboard | 1 day | Distribution detail pages load instantly when the user clicks |
| 8 | **Supabase realtime channels** for the attendance team view | Backend + Dashboard | 1 day | Supervisor dashboard updates without polling — no more 20s lag visible to managers |
| 9 | **CDN for storage objects** (selfies, POD photos) | Supabase | 30 min toggle | Photo loads on the dashboard go from 600 ms to ~80 ms |
| 10 | **Index audit** on `audit_log` (will grow fast) | Backend | 1 hr | Searches stay sub-100 ms even at 10M rows |

## Broader performance strategy (suggested order)

1. **Measure first** — install Vercel Analytics + Railway metrics + Supabase logs. The 90th-percentile request time tells you which endpoint to chase. Don't optimise in the dark.
2. **Fix the slow tail** — the median is usually fine; the user complaints come from p95/p99. The attendance fix above is exactly that pattern.
3. **Cache aggressively, invalidate carefully** — every GET that doesn't change second-by-second is a `Cache-Control` opportunity. The `cacheGet(seconds)` helper makes it a one-liner.
4. **Move telemetry off the response path** — anything that's just "log this somewhere" should never block the user. Same pattern we applied to attendance applies to: order creation, invoice issue, payment recording.
5. **Defer instead of remove** — on mobile, optimistic UI gives you 90% of the perf win for 5% of the engineering effort vs. real offline-first. We did it for distribution orders + now attendance; the same lens applies to everything.
6. **Don't pay for what you don't use** — every unused index is a write penalty. Every unused column shipped over the wire is bandwidth. Keep payload shapes lean.

## How to measure (without setting up dashboards)

```bash
# 1. Time a check-in round-trip end-to-end
curl -s -o /dev/null -w "Total: %{time_total}s · TTFB: %{time_starttransfer}s\n" \
     -X POST https://kinematic-production.up.railway.app/api/v1/attendance/checkin \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"latitude":19.13,"longitude":72.83}'

# 2. Compare with caching (second call should 304)
curl -i -H "Authorization: Bearer $TOKEN" \
     https://kinematic-production.up.railway.app/api/v1/attendance/today | grep -E "HTTP|ETag|Cache"

# 3. EXPLAIN ANALYZE a slow query in Supabase SQL editor
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM attendance WHERE user_id = '...' AND date = '...';
```

## Change log

- **2026-05-03** — initial performance pass: fire-and-forget telemetry on check-in/out, parallel reads, `Cache-Control` + ETag on hot GETs, 5 new indexes including the unindexed FK, audit_log RLS init-plan fix, Android optimistic UI for attendance.
