# Gomant onboarding

Gomant is a field-sales + distribution client inside the Kinematic org. This is how it is set up, by one
idempotent tool: `src/tools/gomant-setup.ts`.

Nothing here needs a migration. It reads and writes existing tables only, and it is **dry-run by default**.

## Status

| | |
|---|---|
| Tool | `src/tools/gomant-setup.ts` (typechecks clean; planner logic and the database calls are tested against a fake PostgREST server, the SQL below against a throwaway Postgres) |
| Run against the real database | **not yet** (the AWS connection was unavailable when this was written) |
| Database | the **Kinematic** project (CLAUDE.md default tenant). Never Tata. |
| Client id | **not hard-coded**: found by name. The tool prints the id it matched; compare it with the one you expect. |

## Running it

```bash
npx tsx src/tools/gomant-setup.ts                       # dry run: prints the plan, writes nothing
npx tsx src/tools/gomant-setup.ts --apply               # applies it
node dist/tools/gomant-setup.js --apply                 # same, from the built backend image (as onboard-byteback)
npx tsx src/tools/gomant-setup.ts --apply --expect-client-id=<uuid>   # abort unless the name lookup finds this id
```

Flags: `--apply`, `--dry-run` (the default, spelled out), `--expect-client-id=<uuid>`, `--help`. An unknown flag aborts.

Environment: the backend's own. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (the registry in
`src/lib/projects.ts` refuses to load without them) **and** `KINEMATIC_SUPABASE_URL`, `KINEMATIC_SUPABASE_ANON_KEY`,
`KINEMATIC_SUPABASE_SERVICE_ROLE_KEY`.

### How it connects, and why not like the Agrisynx tools

`agrisynx-app-config.ts` and `agrisynx-lead-forms.ts` call the HTTP API with an admin `TOKEN` and a `CLIENT_ID`. That
cannot do this job:

- `PATCH /clients/:id {modules}` **replaces** the client's whole `client_modules` set and rewrites
  `user_module_permissions` for every user. The client already has hand-ticked grants.
- `POST /clients/:id/packages` grants whole packages, not a chosen subset.
- Nothing in the API writes `clients.settings.attendance_rules`, or merges a single `settings` key.

So, like `onboard-byteback.ts`, it uses the service-role client (`adminClientFor('kinematic')`). Because
`adminClientFor()` silently falls back to the default project (Tata in production) when the key is not registered,
the tool first refuses to run if `kinematic` is not configured, if its URL equals the default project's URL, or if the
URL contains Tata's project ref. It prints the database host before doing anything.

It keeps the Agrisynx structure: pure, exported planners, `require.main` guard, and a log line per step with a
`[dry-run]` tag.

## What it does

Every step is skipped when already done. A second run changes nothing.

| # | Step | Table / column | Write rule |
|---|---|---|---|
| 0 | Find the client | `clients` (`id, name, org_id, owner_org_id, is_active, created_at, settings`) | read only. Name compared trimmed and case-insensitively. **Zero or more than one live match: prints the candidates and stops.** A soft-deleted (`settings.deleted_at`) twin is ignored and mentioned. |
| 1 | Grant modules | `client_modules` (`client_id, module_id, enabled, source, notes`) | **insert only**, `ON CONFLICT (client_id, module_id) DO NOTHING`; `enabled=true, source='manual', notes='gomant-setup'`. Existing rows are never updated, disabled or deleted, including disabled / expired ones (reported only). Reads `modules` (`id, name, package, is_universal`) and `v_client_enabled_modules`; never writes the registry. |
| 2 | Hide menus in the Android app | `clients.settings.app_ui` | merged key by key into what is there |
| 3 | Attendance rules | `clients.settings.attendance_rules` | written **only if absent** (or JSON null). Never overwritten. |
| 4 | Rupee targets | none | **not enabled**, see below |
| 5 | Checklist | none | printed only; no user, outlet, SKU or Tally record is created |

Steps 2 and 3 are one read-merge-write of `clients.settings` (other keys such as `disable_live_tracking` are kept).
The settings are re-read just before the write, and read back afterwards to verify. There is a sub-second window where
an admin saving at the same moment could be overwritten; the single-statement SQL below has no such window.

After `--apply` it re-reads `client_modules` and `v_client_enabled_modules` and fails loudly if anything is missing.

The tool does **not** touch `user_module_permissions`. `requireModule()` (`src/middleware/auth.ts`) passes on the
entitlement alone, and there are no Gomant users yet.

## Modules

Granted (only the ones that are missing). The live registry decides which are skipped.

| Group | Module | Why (from the code) |
|---|---|---|
| field force | `attendance` | Attendance tab, check-in / check-out |
| | `live_tracking` | live tracking map and pings |
| | `analytics` | `requireModule('analytics')` |
| | `reports` | `requireModule('reports')`; also gates `/distribution/reports` |
| | `orders` | field-force orders (package `field_force`) |
| | `work_activities` | work-activity log written on check-in / out |
| | `route_plan` | **not a registry id**: route-plan routes carry no module gate, and the Android Route Plan tab keys off the `field_force` package |
| | `visit_logs` | visit logs (`people`) |
| | `form_builder` | forms; also what shows the Android "New Form" tab |
| | `activities`, `stores`, `users`, `zones`, `cities` | `requireModule(...)` of the same name |
| | `settings` | dashboard Settings (`system`) |
| | `leave` | registered **universal** by `migrations/leave_module_registration.sql`: always on, so no row is written |
| distribution | `distribution` | the base SKU: gates `/distribution/control-tower`, `/stages`, `/ai` and the dashboard Integrations page; the paid Distribution SKU is never implied (`src/lib/entitlements.ts`) |
| | `distribution_orders`, `_payments`, `_ledger`, `_stock`, `_van`, `_damage`, `_returns`, `_invoicing`, `_distributors`, `_pricing`, `_schemes` | the matching `/distribution/*` route (`src/app.ts`); `_stock`, `_van`, `_damage` also drive the Android "Distributor Stock", "Van Load", "Log Damage" menu entries |
| added with the brief | `distribution_reconciliation`, `notifications` | `/distribution/reconciliation`; notifications |

**Tally integration page.** The dashboard shows Distribution -> Integrations when the user has `distribution`
(`kinematic-dashboard`, `src/app/dashboard/layout.tsx`). The backend routes (`/api/v1/distribution/integrations`) have no module gate, only
`requireAuth`. What Tally pushes (invoices, payments, returns) is covered by `distribution_invoicing`,
`distribution_payments`, `distribution_returns`. No other module is needed.

**Never granted by this tool:** anything starting `crm` (including `crm_conversation_intel`), `finance`,
`field_expenses`, `planogram(s)`, and `route_optimization` (not needed). The tool aborts if one of its own ids matches, or
if the registry puts one in the `crm` / `finance` package. If the client **already holds** one, it prints a warning but
does not remove it (a client created from the dashboard without an explicit module list gets the whole CRM package by
default, see `defaultClientModuleIds()`).

**Left exactly as they are** (already on the client, not part of this set): `dashboard`, `ffm_reports`,
`face_attendance`, `inventory`, `skus`, `assets`, `distribution_receiving`, `distribution_promotions`.

`face_attendance` stays. With it on, the first selfie check-in auto-enrols the face and later check-ins carry a match
score; if the model or the network is unavailable the app falls back to a plain selfie (`AppViewModel.computeFaceStamp`),
so it does not block check-in. Settings also shows a face-enrolment row (`settings.face_enrollment`).

## Android app: `clients.settings.app_ui`

The app reads `app_ui` from `/auth/me` as `app_ui_config` (`Entitlements.kt`, model `AppUiConfig`). It is **hide-only**:
`false` hides, absent or `true` defers to the item's own module / package gate. Keys the app does not read are ignored,
so only keys found in the app source are used:

| Key set to `false` | Where the app reads it | Effect |
|---|---|---|
| `tabs.expenses` | `HomeTabs.kt` `homeTabId` | no Expenses bottom tab (it is opt-in anyway) |
| `menu.expenses` | `HomeScreen.kt` side menu | no Expenses entry |
| `menu.crm` | `HomeScreen.kt` side menu | no CRM entry |
| `menu.ask_kini` | `HomeScreen.kt` side menu | no Ask KINI entry |
| `settings.crm_only_mode` | `AllScreens.kt` Settings -> MODULES | no "CRM-only mode" switch (it would hide attendance and routes and show nothing, since there is no CRM) |

What a rep then sees, given the modules above:

- Bottom bar: **Home, Attendance, Route Plan, Activity, New Form** (New Form because `form_builder` is granted). No Expenses.
- Side menu: Home, Profile, Settings, Learning Hub, Log Visit, **My Orders**, **Van Load**, **Distributor Stock**,
  **Log Damage**. No CRM, no Ask KINI, no Expenses. No Broadcast (module not granted), no Stock & Batches
  (`distribution_batches` not granted).
- Home: Stores / Visited / Forms tiles, today's route, and the **My targets** card (only once targets are configured, see below).
- **Orders and collections** have no menu entry of their own. "Book Order" and "Collect Payment" are cards on the
  outlet screen (`FormSelectionScreen.kt`), shown when the client has the `distribution` package **and** an activity
  whose target type is `order_collection` (or whose name contains "order") is assigned on that outlet. Setting that
  activity up on the route plans is data work, see the checklist.
- Whether the Home bar appears at all depends on `hasFieldForce()`, and orders / collections on `hasDistribution()`.
  Both are package checks; the tool prints the packages before and after and warns if either would be missing.

### Left at default, decide

You asked for only the listed tabs and entries to appear. The brief names Expenses and CRM as the things to switch
off, so those are the only forced hides; hiding more would silently remove features from reps. These are still visible
by default and can be hidden with the exact keys below (Client Management -> App Customization, or add them to
`APP_UI_HIDE` in the tool and re-run):

| To hide | Key |
|---|---|
| Activity bottom tab | `tabs.activity` |
| New Form bottom tab | `tabs.new_form` |
| Learning Hub / Profile / Log Visit | `menu.learning_hub` / `menu.profile` / `menu.log_visit` |
| Home tiles | `home.stores`, `home.visited`, `home.forms`, `home.todays_route` |
| Face enrolment row | `settings.face_enrollment` |

Re-running the tool re-asserts the five keys it owns (an admin who turns `menu.crm` back on would see it turned off again).

## Attendance rules

`clients.settings.attendance_rules` (keys all optional; `HH:MM` 24h, `grace_minutes` 0..120, `weekly_off` a subset of 0..6
with 0 = Sunday, IST) is set to

```json
{ "shift_start": "09:30", "shift_end": "18:00", "grace_minutes": 15, "weekly_off": [0], "allow_offline_checkin": true }
```

only if the client has no `attendance_rules` object. An existing object, even `{}`, is **kept** and printed: the
contract defines "configured" as having the object at all, and an admin's saved rules are never overwritten. A malformed
value (string, array) aborts instead of being replaced. The constants are checked against the contract's bounds at start-up.

The reader is `src/services/attendanceRules.service.ts` / `attendanceRules.store.ts` (a separate, uncommitted change when
this was written). Its rules agree with the above: a plain object counts as configured, and the value written here passes
its validators. It reads through the 60 s per-client settings cache, so a change takes up to a minute to show. Until that
change ships, the key is inert.

## Rupee targets (Sales + Collection): not enabled

`agrisynx-app-config.ts` enables them with `crm_settings.config.targets.types`. For Gomant that is not safe:

- The endpoints the app calls (`/api/v1/crm/targets/types`, `/progress`, `/entries`) sit under the CRM router, and the
  whole router is gated by `requireModule('crm')` (`src/routes/crm.routes.ts`, `router.use(requireAuth, requireModule('crm'))`).
- So targets need the **`crm`** module, which is on the do-not-grant list. It would also give the client the `crm`
  package, so the app's `hasCrm()` becomes true and the CRM / Ask KINI menu entries exist (hidden only by `app_ui`).

What it would take, all of:

1. Grant `crm` (package `crm`) to the client. Step 2 already sets `menu.crm` and `menu.ask_kini` to `false`.
2. `crm_settings` row for the client (`org_id` + `client_id`; if the client has none, the org default row is read,
   `loadCrmConfig` in `src/services/crm/leadFormConfig.ts`) with
   `config.targets.types = [{"key":"sales"},{"key":"collection"}]`. Use `PATCH /api/v1/crm/settings`, which replaces each
   top-level `config` key it is sent as a whole, so send the full `targets` object, as `agrisynx-app-config.ts` does.
3. `migrations/crm_target_entries.sql` applied (psql, as the table owner) so reps can log entries; until then the API
   answers 409 `TARGET_ENTRIES_NOT_ENABLED`.
4. Nothing on Android: the Home "My targets" card appears once `/crm/targets/types` returns types, and `home.my_targets`
   is left visible.

## Still needs a human

The tool prints this checklist and creates none of it.

- **Users**: admin(s), supervisor(s), sales reps. For each: name, email, mobile (10 digits, unique per org), designation, city.
- **Hierarchy**: who reports to whom (`users.supervisor_id`), designations in `org_roles` (`data_scope` team / own).
  Tick the modules above on each designation: once a designation's permission list is non-empty, the dashboard hides any
  module not listed on it. Zone / city assignment per rep.
- **Masters**: outlets (with the distributor each is assigned to), distributors, SKUs / products (and brands), price
  list(s), schemes, route plans per rep, and the `order_collection` activity on those routes (see above).
- **Tally** (Distribution -> Integrations -> Connect Tally): the exact Tally company name (it becomes
  `SVCURRENTCOMPANY` in every voucher), the ledger names in that company (Sales, Cash, Bank, CGST, SGST, IGST, Sales
  Returns / credit note), and a Windows PC with Tally on which to install the bridge agent (the agent secret is shown once).
- **Decisions**: attendance rules above; whether to hide more of the app bar; whether rupee targets justify granting `crm`.

## Plain SQL (if running node is awkward)

Same effect as steps 1 to 3, each a single statement, idempotent, and refusing to act unless exactly one live client is
named Gomant. Tested against a throwaway Postgres (empty settings, existing admin rules, JSON nulls, two clients with
the name, a soft-deleted twin, re-runs). Run the check first:

```sql
SELECT id, name, org_id, owner_org_id, is_active, created_at
FROM clients
WHERE lower(btrim(name)) = 'gomant' AND (settings->>'deleted_at') IS NULL;   -- expect exactly one row
```

**1. Module grants** (insert-only; ids missing from the registry and universal modules are skipped):

```sql
WITH c AS (
  SELECT id FROM clients
  WHERE lower(btrim(name)) = 'gomant' AND (settings->>'deleted_at') IS NULL
),
want(module_id) AS (VALUES
  -- field force
  ('attendance'), ('live_tracking'), ('analytics'), ('reports'), ('orders'), ('work_activities'),
  ('route_plan'), ('visit_logs'), ('form_builder'), ('activities'), ('stores'), ('users'),
  ('zones'), ('cities'), ('settings'), ('leave'),
  -- distribution
  ('distribution'), ('distribution_orders'), ('distribution_payments'), ('distribution_ledger'),
  ('distribution_stock'), ('distribution_van'), ('distribution_damage'), ('distribution_returns'),
  ('distribution_invoicing'), ('distribution_distributors'), ('distribution_pricing'), ('distribution_schemes'),
  -- added with the brief
  ('distribution_reconciliation'), ('notifications')
)
INSERT INTO client_modules (client_id, module_id, enabled, source, notes)
SELECT c.id, m.id, true, 'manual', 'gomant-setup'
FROM c
CROSS JOIN want w
JOIN modules m ON m.id = w.module_id            -- ids that are not in the registry are skipped
WHERE (SELECT count(*) FROM c) = 1              -- exactly one live client called Gomant, else nothing
  AND COALESCE(m.is_universal, false) = false   -- universal modules are always on and need no row
ON CONFLICT (client_id, module_id) DO NOTHING   -- never touches an existing grant
RETURNING module_id;
```

**2 + 3. App menus and attendance rules** (one atomic `UPDATE`; every other `settings` key is kept, rules only if absent):

```sql
WITH one AS (
  SELECT id, COALESCE(settings, '{}'::jsonb) AS s
  FROM clients
  WHERE lower(btrim(name)) = 'gomant' AND (settings->>'deleted_at') IS NULL
),
pick AS (SELECT * FROM one WHERE (SELECT count(*) FROM one) = 1)   -- exactly one match, else nothing
UPDATE clients cl
SET settings = jsonb_set(
      -- attendance_rules: only when the client has none (absent or JSON null)
      CASE WHEN COALESCE(jsonb_typeof(pick.s -> 'attendance_rules'), 'null') <> 'null'
           THEN pick.s
           ELSE pick.s || jsonb_build_object('attendance_rules',
                '{"shift_start":"09:30","shift_end":"18:00","grace_minutes":15,"weekly_off":[0],"allow_offline_checkin":true}'::jsonb)
      END,
      '{app_ui}',
      -- app_ui: our hide-only keys merged group by group; every other key and group is kept
      COALESCE(NULLIF(pick.s -> 'app_ui', 'null'::jsonb), '{}'::jsonb) || jsonb_build_object(
        'tabs',     COALESCE(NULLIF(pick.s -> 'app_ui' -> 'tabs',     'null'::jsonb), '{}'::jsonb) || '{"expenses":false}'::jsonb,
        'menu',     COALESCE(NULLIF(pick.s -> 'app_ui' -> 'menu',     'null'::jsonb), '{}'::jsonb) || '{"expenses":false,"crm":false,"ask_kini":false}'::jsonb,
        'settings', COALESCE(NULLIF(pick.s -> 'app_ui' -> 'settings', 'null'::jsonb), '{}'::jsonb) || '{"crm_only_mode":false}'::jsonb
      )
    )
FROM pick
WHERE cl.id = pick.id
RETURNING cl.id, cl.settings;
```

If `settings.app_ui` (or one of its groups) is a string or array, the SQL would mangle it, where the tool aborts. Check
first: `SELECT settings -> 'app_ui' FROM clients WHERE id = '<id>'`.

**Verify** (replace `<id>` with the id from the check above):

```sql
SELECT module_id, enabled, expires_at, source, notes FROM client_modules WHERE client_id = '<id>' ORDER BY module_id;
SELECT module_id, package FROM v_client_enabled_modules WHERE client_id = '<id>' ORDER BY package, module_id;
SELECT settings -> 'app_ui' AS app_ui, settings -> 'attendance_rules' AS attendance_rules FROM clients WHERE id = '<id>';
```

Expect `field_force` and `distribution` among the packages, and no `crm` or `finance`.

## Rollback

Only what this tool added:

```sql
DELETE FROM client_modules WHERE client_id = '<id>' AND notes = 'gomant-setup' RETURNING module_id;

UPDATE clients
SET settings = settings #- '{app_ui,tabs,expenses}' #- '{app_ui,menu,expenses}' #- '{app_ui,menu,crm}'
                        #- '{app_ui,menu,ask_kini}' #- '{app_ui,settings,crm_only_mode}'
WHERE id = '<id>' RETURNING settings;

-- optional, only if you want the attendance rules gone too:
-- UPDATE clients SET settings = settings - 'attendance_rules' WHERE id = '<id>';
```

## After applying

- A running API caches entitlements for about 60 seconds and a signed-in user's profile (including enabled modules) for up
  to 5 minutes. Reps who were signed in may need to sign in again. `/auth/me` reads `app_ui` straight from the database.
- The tool runs outside the API process, so it cannot clear the API's in-memory caches.

## Not verified

- The tool has **not** been run against the real database. It was tested against a fake PostgREST server (the exact
  `supabase-js` request shapes: `on_conflict`, `Prefer: resolution=ignore-duplicates`, the five columns per grant) and
  the SQL against a throwaway Postgres with stub tables.
- `client_modules.notes` comes from a live schema read; no other code in this repo references that column. If it were
  missing, the insert fails with a clear error and nothing else is written.
- Which modules are `is_universal` in the live registry was not checked. `leave` is expected to be (the migration says
  so); any other universal module is skipped by the tool and the SQL, and the dry run lists them.
- The Android behaviour above is from reading the source (`Entitlements.kt`, `HomeTabs.kt`, `HomeScreen.kt`,
  `FormSelectionScreen.kt`, `AllScreens.kt`), not from running the app.
- The `attendance_rules` reader was uncommitted work from another change at the time; nothing here depends on it, but the
  rules only take effect once it is deployed.
