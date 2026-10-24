# Client module visibility and app layout — contract

Applies to: backend (`Kinematic`), dashboard (`kinematic-dashboard`), Android (`Kinematic-App`), iOS (`Kinematic-iOS`).
Source of truth in code: `src/lib/appItems.ts` (backend). The dashboard mirrors it in `src/lib/appCustomization.ts`.

## 1. A client sees only what Client Management ticked

- No module is "universal" any more (`modules.is_universal` is false for all). Every module, including Users, Settings,
  Reports, Leave, Broadcast, Notifications, is a tick in Client Management → Module Access.
- `GET /auth/me` and the login response return, on the user:
  - `enabled_modules: string[]`, `enabled_packages: string[]`
  - **`entitlements_strict: boolean`** — `true` means `enabled_modules` is the COMPLETE list this client was given.
    An empty list then means *nothing* (not "unknown, show the defaults"). Absent/`false` = legacy behaviour
    (platform users, Tata, or a failed lookup): keep the old lenient reading.
- The server also switches off, inside `app_ui_config`, every screen whose module is not ticked
  (`<section>.<id> = false`). Apps already honour those flags, so older builds hide the screens too.
- Apps must additionally treat `entitlements_strict == true` as: `hasModule(x)` is true **only** if `x` is in
  `enabled_modules` (no "empty list = everything" leniency), and package checks (`hasCrm()`, `hasFieldForce()`,
  `hasDistribution()`) come from `enabled_packages` only.

### Screen → module (what the server enforces via `app_ui_config`; apps should gate with the same rule)

| section | id | needs |
|---|---|---|
| menu | profile | — (essential) |
| menu | notifications | notifications |
| menu | broadcast | broadcast |
| menu | learning_hub | learning |
| menu | log_visit | visit_logs |
| menu | leaderboard | leaderboard |
| menu | activity_feed | activity_feed |
| menu | stock | inventory |
| menu | grievance | grievances |
| menu | emergency_sos | emergency_sos |
| menu | expenses | field_expenses |
| menu | leave | leave |
| menu | timeline | timeline |
| menu | planogram | planograms |
| menu | book_order, my_orders | distribution_orders |
| menu | collect_payment | distribution_payments |
| menu | van_load | distribution_van |
| menu | distributor_stock | distribution_stock |
| menu | log_damage | distribution_damage |
| menu | stock_batches | distribution_batches |
| menu | crm, ask_kini | package `crm` |
| tabs | attendance | attendance |
| tabs | route_plan | orders |
| tabs | activity | activities |
| tabs | new_form | form_builder |
| tabs | expenses | field_expenses |
| home | stores | stores |
| home | visited | visit_logs |
| home | forms | form_builder |
| home | todays_route | orders |
| home | open_volume | crm_dashboard |
| home | my_targets | — |
| settings | appearance, crm_only_mode, app_lock, about, rate_app | — |
| settings | face_enrollment | face_attendance |
| crm_more | accounts | crm_accounts |
| crm_more | pipeline | crm_pipeline |
| crm_more | products | crm_products |
| crm_more | custom_objects | crm_settings |
| crm_more | nearest_leads | crm_leads |
| crm_more | leave | leave |
| crm_more | expenses | field_expenses |
| crm_more | dashboard | crm_dashboard |
| crm_more | lead_analytics | crm_lead_analytics |
| crm_more | reports | crm_reports |
| crm_more | switch_ff | package `field_force` |

CRM shell main bottom tabs (not in `app_ui_config`): Leads needs `crm_leads`, Deals/Pipeline `crm_deals`/`crm_pipeline`,
Activities `crm_activities`, Home/More are essential. Gate each under `entitlements_strict`.

## 2. App layout (drag and drop in Client Management)

`app_ui_config.layout` (optional, additive; older builds ignore it):

```json
"layout": {
  "tabs":     ["attendance", "route_plan", "leave", "activity"],
  "menu":     ["profile", "broadcast", "log_visit"],
  "settings": ["appearance", "app_lock"],
  "crm_more": ["pipeline", "accounts"],
  "home":     ["stores", "visited"]
}
```

- Ids are the same ids used by `menu` / `tabs` / `settings` / `crm_more` / `home` hide flags.
- The server has already removed unknown ids, duplicates and screens whose module is not ticked, capped `tabs` at 4,
  and removed from `menu` any id that is in `tabs`.
- **Order** (every container): ids listed come first, in the listed order; items not listed keep their default relative
  order after them. Essential fixed entries stay where they are (Home first and Sign Out last in the side menu).
  Hide flags still win: an id with `<section>.<id> == false` is not shown even if listed.
- **Bottom bar** (field-force shell): if `layout.tabs` is present and non-empty the bar is **Home + layout.tabs**, in that
  order (≤ 4 after Home). Bar-capable ids: attendance, route_plan, activity, new_form, expenses, leave, timeline,
  log_visit, broadcast, notifications, crm, my_orders, book_order, collect_payment. `attendance`, `route_plan`,
  `activity` are the existing content tabs; every other id is an *action tab* that navigates to the same destination
  the side-menu entry opens (same route, same icon, same label — including `labels.menu.<id>` renames). An id is
  dropped from the bar when its app-level gate is false (module, package, tenant rules) or its hide flag is false.
  A screen shown in the bar is not repeated in the side menu. If the filtered list is empty the bar is Home only.
  If `layout.tabs` is absent: the existing logic (`fieldForceTabs` / tab hide flags / `tabs.expenses` opt-in) is unchanged.
- Not draggable into other containers: settings rows, CRM More rows and Home cards can only be re-ordered.

## 3. Backend gate (belt and braces)

`middleware/moduleGate.ts` logs (`MODULE_GATE=shadow`, default) or refuses (`MODULE_GATE=enforce`) calls to routes whose
module the client has not ticked. Existing `requireModule` mounts are strict now (an empty complete list denies).

`GET` / `HEAD` on `/cities`, `/zones` and `/stores` are never refused: other screens read them as reference data
(filters, pickers, attendance, forms), so only writes there need the module. The shadow line also names the caller's
`role` and `ua` (app or browser), so a review can tell a screen's call from an app's background refresh (the apps call
`/broadcast`, `/leaderboard` and `/route-plan` on every home refresh; they ignore a refusal, but the clean fix is for them to
skip the call when the module is not held).
