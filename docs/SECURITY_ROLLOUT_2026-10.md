# Security hardening rollout (2026-10 audit) — flags and what to watch

Everything below ships **safe by default**: hard fixes only where the old behaviour had no legitimate use, and an
observe-first "shadow" mode (a `[authz-shadow]` warning in the backend log) where a tenant might depend on it.
Search the CloudWatch group `/ecs/kinematic` for the tags; flip a flag only after a quiet week.

| Area | Default | Flag to enforce | Log tag to watch |
|---|---|---|---|
| Manage a user (PATCH /users/:id, reset password, send reset): must be in your org, a client your org owns, or you are a platform operator; only a super_admin may manage a super_admin; nobody raises their own role | enforced | — | `[authz-deny] updateUser / resetUserPassword / sendUserPasswordReset` |
| Manage / assign a role **above your own** | log only | `USER_RANK_ENFORCE=on` | `[authz-shadow] … higher role` |
| `X-Org-Id` act-as for a `super_admin` who is not a named platform operator | **enforced** (header ignored); zero hits in the 7 days before it was switched on | `IMPERSONATE_OPERATOR_ONLY=off` = log only | `[authz-deny] non-operator super_admin` |
| Form builder: pages / questions / submissions of another org's form | **enforced** everywhere, app-facing reads and submit included; zero hits in the 7 days before | `BUILDER_ORG_ENFORCE=off` = log only | `[authz-deny] getPages / getQuestions / createFormSubmission / getTemplate` |
| Tata `default` project: team reads (Work Activities, team attendance, attendance summary, route plans) | **enforced**: one org per request; only a named platform operator keeps the aggregated "All clients" view; a picked client must be the caller's | `TENANT_LEGACY_SCOPE=on` restores the old any-admin view and unverified picks (Tata only) | 404 `Client not found` |
| Single submission / form-response read by id (all projects) | **enforced**: another org's row is a 404 | — | — |
| WhatsApp webhook signature | unsigned accepted + warning | `WHATSAPP_WEBHOOK_STRICT=on` (needs `CRM_WHATSAPP_APP_SECRET`) | `[whatsapp-webhook] unsigned` |
| Lookup picker (`/crm/lookup/search`) | curated + catalogue tables only, credential tables/columns refused | — | 400 `BAD_TARGET` |
| Lead-source integrations | writes need the `crm_settings` module; reads without it carry no config/secret | — | `[authz-deny] integrations` |
| Messaging directory / audit | admin tier is limited to its own org; operators keep the cross-org view | — | — |

Platform operators are the e-mails in `CROSS_ORG_SUPERADMIN_EMAILS` (default list in `src/lib/tenantScope.ts`).

Who loses the all-orgs view on Tata (they now see their own org only): anyone who is not a listed operator — an unbound
`admin` / `super_admin` who is not on the list, a client-role user, and any user whose *name* contains "sagar".

Also in this change: the debug route `POST /misc/debug/nuke-test-fe` is gone, `GET /analytics/mobile-home` no longer
deletes attendance rows, the runtime image now contains `public/` (so `/embed.js` and planogram reference images are
served), and the demo login (a fixed token, enabled by `DEMO_MODE=on`) can no longer reach the control-plane,
role-edit or shared-candidate routes.

Rollback: every change is a plain code change on this branch; reverting the merge restores the previous behaviour.
