# Kinematic Platform — Security & Data-Protection Audit (VAPT + GDPR + DPDP)

> **Date:** 2026-07-13  ·  **Type:** Full-scope security & privacy compliance audit
> **Scope:** Backend API (`Kinematic`), Web dashboard (`kinematic-dashboard`), iOS (`Kinematic-iOS`), Android (`Kinematic-App`), and both Supabase production projects.
> **Frameworks:** OWASP Top 10 (2021) / MASVS-MASTG (mobile) / EU GDPR (2016/679) / India DPDP Act 2023.
> **Purpose:** Establish audit-readiness so the platform passes a third-party VAPT and a formal GDPR/DPDP compliance review.

This report supplements — it does **not** replace — `SECURITY.md`. Where a `SECURITY.md`
claim was tested against the actual code and found overstated or false, it is called out
explicitly in §8 (Claim scorecard).

---

## 1. Executive summary

The platform has a **genuinely strong perimeter/security-hardening baseline** (helmet, HSTS,
CORS allowlist, per-route rate limits, immutable audit log, prototype-pollution guard,
slowloris timeouts, signed-upload validation, verified JWT signatures, correct RLS
deny-by-default on 95 tables). The May-2026 VAPT pass delivered real value and most of its
claims hold up in code.

However, the audit surfaced **five Critical issues** that would each independently fail a
compliance test, and a systemic **data-protection (privacy) immaturity** — the product is
security-hardened but privacy-unready.

### Verdict by regime
| Regime | Verdict | Headline reason |
|---|---|---|
| **VAPT / OWASP** | **Fail (remediable)** | Cross-tenant IDOR (any user reads another tenant's HR/GPS data); a live private key committed to git. |
| **GDPR** | **Fail** | No data-subject-rights machinery (access/erasure/portability); no lawful-basis/consent record; no ROPA/DPA; world-readable employee images. |
| **DPDP Act 2023** | **Fail** | No §5 notice / §6 consent; no §11–12 access/correction/erasure; no §9 children's-data age-gating; Indian personal data processed in Australia (§16). |

### The five Criticals (fix before any pen-test / audit)
1. **C-1 — Cross-tenant IDOR** (backend): any authenticated user of any tenant can read another tenant's attendance, GPS visits, user roster, SOS alerts and **HR grievances** by passing `?client_id=<other-org-uuid>`. *Independently verified in code.*
2. **S-1 — Live Firebase service-account private key committed to git** (`firebase_b64.txt`). *Independently verified — real 2048-bit key, project `kinematic-bc221`, committed in `d293e45`.*
3. **PR-1 — Public selfie / form-photo storage buckets** — employee attendance selfies (biometric-adjacent) and form photos are world-readable by URL, retained indefinitely.
4. **PR-2 — No data-subject / data-principal rights mechanism** — no access, erasure, rectification or portability flow exists anywhere in the codebase.
5. **PR-3 — Soft-delete never purges PII** — every "delete" sets `deleted_at`; name/phone/email/DOB/GPS persist forever, defeating erasure and storage-limitation duties.

### Findings by severity (all repos)
| Severity | Count | Examples |
|---|---|---|
| **Critical** | 5 | C-1 IDOR, S-1 leaked key, public buckets, no-DSAR, soft-delete-no-purge |
| **High** | 11 | Demo super-admin bypass token, mass-assignment, CORS pattern bypass, mobile plaintext token storage (iOS+Android), web `localStorage` tokens+PII, no consent, no privacy policy/DPA, no DOB age-gate, cross-border transfer, PII→Anthropic, PII reads unaudited |
| **Medium** | ~18 | Login limiter degraded, PII in logs/audit_log, spoofable MIME, CSP wildcards, no cert pinning (×2), no lockfile, outdated Next.js/multer/firebase-admin, no retention, DPIA absent, etc. |
| **Low / Info** | ~15 | OAuth-state fallback secret, deep-link hijack (×2), force-push deploy, search_path, extensions-in-public, HIBP off, etc. |

---

## 2. Scope & methodology

- **6 parallel domain audits** (backend authz/injection, backend hardening/secrets, web, iOS, Android, GDPR/DPDP) with real file reads and `file:line` citations.
- **Live Supabase security advisors** pulled for both production projects (read-only).
- **Independent verification** of the two most severe application findings (C-1 IDOR, S-1 leaked key) and the live database posture by the lead auditor.
- Static review only — no runtime exploitation, no live MITM, no DB write tests. Items that
  could not be confirmed statically are marked *"unverified"* in §9.

**Infrastructure / processor map (personal data flows through all of these):**
Supabase (Postgres + Auth + Storage, **region `ap-southeast-2` / Sydney**), Railway (API),
Vercel (web), Firebase/FCM (`firebase-admin`), Anthropic (AI features — receives lead/contact
PII), plus optional GSTIN-verify and e-invoice/e-way GSP providers.

---

## 3. Live database posture (Supabase advisors — verified 2026-07-13)

Both `Kinematic-Production` (`clldjlojtmrrpozydqxk`) and `SRS - TATA Steel`
(`lnvxqjqfsxvtjvbzphou`) were scanned live.

| Finding | Level | Notes |
|---|---|---|
| **No `rls_disabled_in_public` tables** | ✅ Good | RLS is deny-by-default across 95 tables — genuinely fail-closed; backend uses service-role and bypasses. This confirms `SECURITY.md`'s RLS claim. |
| `auth_leaked_password_protection` **disabled** | ⚠️ Warn | HaveIBeenPwned check **OFF on both prod projects**. Confirms `SECURITY.md` open item #1. One-click fix: Auth → Settings → Password Protection. |
| `function_search_path_mutable` on `public.current_org_id` | ⚠️ Warn | The function that enforces **tenant scoping** has a mutable `search_path` (search-path-hijack surface). Set `search_path = ''` / `pg_catalog`. (Kinematic-Prod.) |
| `extension_in_public` — `pg_net`, `citext`, `pg_trgm` | ⚠️ Warn | `pg_net` grants DB-side outbound HTTP; relocate extensions out of `public`. |
| 95 × `rls_enabled_no_policy` | ℹ️ Info | Deny-all (safe); add explicit policies only if anon/authenticated read is ever needed. |

**No ERROR-level advisories** on either project — the DB layer is the strongest part of the stack.

---

## 4. Backend (`Kinematic`) — application security

### 4.1 Critical

**C-1 — Cross-tenant IDOR via `client_id` query param** *(verified)*
- `src/controllers/visitlog.controller.ts:167-169`, `src/controllers/analytics.controller.ts:40-46`, plus `misc.controller.ts` (lines 21, 98, 116, 768, 832, 850, 869, 896, 961) and `attendance.controller.ts:416` — **~15 sites across 4 files.**
- Pattern: `targetCid = isUUID(req.query.client_id) ? req.query.client_id : user.client_id;` then `query.or('client_id.eq.${targetCid},org_id.eq.${targetCid}')`. The supplied UUID is **never checked against the caller's own org**, and the `org_id.eq.<supplied>` branch replaces (rather than ANDs) the caller's scope.
- **Exploit:** `GET /api/v1/visits/team?client_id=<victim-org-uuid>` (also `/analytics/summary`, `/grievances`, `/attendance/*`) returns the victim tenant's rows. Org/client UUIDs are not secrets (they appear in responses and `X-Org-Id`). Uses `supabaseAdmin` → RLS does not save you.
- **Fix:** ALWAYS `q.eq('org_id', user.org_id)` first; only then optionally `q.eq('client_id', suppliedUuid)` **after verifying that client belongs to the caller's org**. Never interpolate `org_id.eq.${param}`. Route through the same `clientScope()` helper the CRM module already uses correctly.

**S-1 — Live Firebase private key committed to git** *(verified)*
- `firebase_b64.txt` (git-tracked, first appears in commit `d293e45`). Base64 decodes to a full `service_account` JSON for `kinematic-bc221` with a 1704-char `private_key`. Runtime reads the key from `FIREBASE_SERVICE_ACCOUNT` env, so **the file is unused** — pure leakage.
- **Impact:** full Firebase Admin — push arbitrary FCM to all users, impersonate the backend.
- **Fix (do now, in order):** (1) **Revoke/rotate** the key in Google Cloud IAM — treat as fully compromised. (2) `git rm firebase_b64.txt`, add to `.gitignore`. (3) Purge from history (BFG / `git filter-repo`) and force-rotate — the key is exposed in every clone until history is scrubbed.

### 4.2 High

- **H-1 — Hardcoded demo super-admin bypass token.** `src/middleware/auth.ts:182-200`: `Authorization: Bearer demo-token-jwt-placeholder` is accepted with **no signature check** and granted `role: super_admin`. Mitigated today because it pins to a sentinel `DEMO_ORG_ID` (`00000000-…-999`) before impersonation — but it is a shipped, guessable, un-authenticated super-admin credential. Same for the `demo@kinematic.com` email elevation (`auth.ts:248-254`). **Fix:** gate behind `NODE_ENV !== 'production'` + explicit env flag, or remove.
- **H-2 — Mass-assignment of `owner_id` / `client_id`** on CRM create/update. `crm.validators.ts` exposes both; `crm.routes.ts:606` does `client_id: rest.client_id ?? clientId(req)` (body wins) and `leads.service.ts:58` lets body `owner_id` win. A rep can reassign records or (since Tata + Kinematic share an `org_id`) write into another client bucket intra-org. `org_id` itself is correctly force-set server-side. **Fix:** drop `owner_id`/`client_id` from client-writable schemas; force `client_id` from `clientScope(req)`.
- **C1 — CORS pattern bypass with `credentials:true`.** `src/middleware/security.ts:63-94`: `KNOWN_PATTERNS` matches `https://kinematic-dashboard-[a-z0-9-]+.vercel.app` (any Vercel user can name a project that) and `https://[a-z0-9-]+.kinematicapp.com` (every subdomain — one subdomain takeover = credentialed cross-origin read). Always on; **no `CORS_ALLOW_VERCEL_PREVIEWS` env gate exists** (contradicts `SECURITY.md`). **Fix:** pin exact preview hashes; replace subdomain wildcards with an explicit allowlist.

### 4.3 Medium

- **R-1 — Login limiter degraded to IP-only.** `loginLimiter` (`app.ts:223`) is mounted **before** `express.json()` (`app.ts:233`), so its `keyGenerator` reads an `undefined` `req.body.email` and always falls back to IP. The advertised per-(IP,email) protection never engages → distributed brute-force across IPs is not throttled. **Fix:** mount after the body parser.
- **U-1 — Spoofable upload MIME + memory-DoS.** `src/middleware/upload.ts:16-50` trusts client `Content-Type` (not magic bytes); combined with the public selfie/form-photo buckets this enables stored-XSS/malicious hosting off a Kinematic domain. `uploadMaterial` buffers **100 MB** into memory. **Fix:** validate magic bytes (`file-type`); stream large uploads; make buckets private.
- **P-1 — Secrets in access logs.** `morgan('combined')` (`app.ts:226`) logs full query strings; endpoints like `/f/:id?key=<webhook_secret>`, `/crm/unsubscribe?t=<token>` write per-integration secrets/tokens into `combined.log` (and any Railway drain). **Fix:** redact `key`/`t`/`token` query params.
- **P-2 — Lead PII in `audit_log`.** `src/middleware/auditAll.ts:37-47` redacts only credential keys; the full request body (name/email/phone/city/coords) is stored in `audit_log.after` in plaintext + `ip_address`/`user_agent`, admin-readable, no retention. GDPR/DPDP-relevant. **Fix:** mask/tokenise PII fields; set retention + erasure.
- **P-3 — Spoofable audit IP.** `auditAll.ts:219` takes the leftmost `X-Forwarded-For` (client-controlled) instead of `req.ip`. Forensic IPs can be forged. **Fix:** use `req.ip`.
- **M-1 / M-2 — Pre-auth injection sinks.** Login mobile-lookup (`auth.controller.ts:165-171`) interpolates an unvalidated local-part into `.or()`; user-create dup check (`misc.controller.ts:479`) interpolates raw input **and lacks an `org_id` scope** (cross-org existence oracle). Bounded impact but fix with `.in()`/validation + org scoping.
- **M-3 — JWT `aud`/`iss` unchecked.** `src/lib/projects.ts:223-232` verifies signature + expiry but passes no `audience`/`issuer`. Defence-in-depth. **Fix:** pass `{ issuer, audience: 'authenticated' }`.
- **D-1 / D-2 — Supply chain.** No committed lockfile (`.gitignore` ignores `package-lock.json`) → non-reproducible, unauditable builds; `multer@1.x` (deprecated, DoS advisories), `express@4.19`, `firebase-admin@11` (v13 current). **Fix:** commit lockfile + `npm ci`; upgrade multer→2.x, firebase-admin→13; add Dependabot + `npm audit` in CI.

### 4.4 Low / Info

- **S-2 —** `app.ts:292` OAuth-state secret falls back to `'dev-only-secret-replace-me'` if envs unset → forgeable `state`. Hard-fail instead.
- **DP-1 —** `package.json` `deploy:direct` does blind `git add .` + `git push --force` to shared `main` (plausibly how `firebase_b64.txt` was committed). Use `--force-with-lease`, scope the add.
- **E-1 —** Dead `src/middleware/errorHandler.ts` leaks `err.message` + unredacted `req.body`; not wired, but delete it to remove the footgun.
- **L-1 —** `crm.routes.ts:1556` activity search strips only `%`/`,`; use the shared `sanitisePostgrestSearch()`.

### 4.5 Verified SECURE (preserve these)
JWT signatures are genuinely verified (jose `jwtVerify` against per-project JWKS, then admin fallback); every `/api/v1/*` route is behind `requireAuth` (public surfaces are individually key/HMAC-authenticated); **CRM-module tenant isolation is correct** (`clientScope()` + forced `orgId(req)` + `strictClient`) — C-1 is the field-force controllers *failing to copy* this pattern; CRM `.or()` interpolations are UUID/enum-guarded and `org_id` is force-set in `crud.create`; unknown body keys are stripped by zod; WhatsApp webhook uses constant-time HMAC; `exec_sql`/`exec_migration` RPCs are gone from runtime.

---

## 5. Web dashboard (`kinematic-dashboard`)

| # | Finding | Severity | Evidence |
|---|---|---|---|
| W-1 | **Access + 30-day refresh token in `localStorage`** (XSS-exfiltratable, incl. super-admin `kinematic_acting_as` impersonation token) | **High** | `src/lib/auth.ts:68-83`, `src/lib/api.ts:164-172,229-268` |
| W-2 | **CRM PII cached to `localStorage`** (leads/contacts/deals — names/phones/emails) via SWR `kapi:` cache | **High** | `src/lib/api.ts:100-127,455-475` |
| W-3 | CSP `connect-src` ends in `https: wss:` **wildcard** → exfil allowlist is cosmetic | Medium | `next.config.mjs:42` |
| W-4 | CSP `script-src 'unsafe-inline' 'unsafe-eval'` | Medium | `next.config.mjs:38` |
| W-5 | **Next.js 14.2.3** — behind patch line (CVE-2024-46982 cache-poisoning, -51479 authz-bypass, -47831 DoS, 2025-29927 middleware-bypass); `ignoreBuildErrors`+`ignoreDuringBuilds` suppress type/lint gates | Medium | `package.json:36`, `next.config.mjs:73-77` |
| W-6 | Route protection client-side only; no `middleware.ts`; `isSessionValid()` only checks a string exists | Medium | `dashboard/layout.tsx:159`, `auth.ts:135-138` |
| W-7 | Regex-only HTML sanitizer in KinematicAI (`dangerouslySetInnerHTML`) — bypassable if escaping order ever changes | Low/Med | `src/components/KinematicAI.tsx:571,131-162` |
| W-8 | Anon-key auth fallback on an "admin" submissions proxy | Low | `app/api/v1/forms/admin/submissions/route.ts:22` |
| W-9 | `service_role` upsert runs **before** caller authz in `POST /clients` | Low | `app/api/v1/clients/route.ts:99-108,59-76` |

**Fixes:** move refresh token to `HttpOnly; Secure; SameSite=Strict` cookie, keep only a short-lived access token in memory; stop persisting CRM PII to `localStorage` (in-memory/`sessionStorage`); enumerate real `connect-src` hosts + nonce-based CSP (drop `unsafe-inline`/`eval`); upgrade Next.js + re-enable build gates; add a validating `middleware.ts`; replace the regex sanitizer with DOMPurify.

**Verified secure:** CSRF-safe (bearer, not cookies); security headers present (HSTS/XFO/XCTO/Referrer/Permissions); `service_role` key is server-only (no `NEXT_PUBLIC_`); no user-controlled redirect/SSRF.

---

## 6. Mobile apps (iOS `Kinematic-iOS` + Android `Kinematic-App`)

Both apps share the same top risk: **long-lived session tokens stored in plaintext at rest.**

| # | Finding | iOS | Android | Sev |
|---|---|---|---|---|
| M-1 | **Access + ~30-day refresh token stored unencrypted** (iOS `UserDefaults`; Android Preferences DataStore) — recoverable via backup/jailbreak/root → durable impersonation | `KinematicApp.swift:1599-1648` | `NetworkModule.kt:48-56,406-411` | **High** |
| M-2 | **Local CRM PII cache unencrypted** (iOS offline queues w/o `NSFileProtection`; Android Room DB not encrypted) | `OfflineLeadQueue.swift:84,153,162` | `KinematicDatabase.kt`, `DatabaseModule.kt:23-27` | **High** (Android compounded by ↓) |
| M-3 | **Android `allowBackup="true"`** + no backup-rules → `adb backup` exfils token file + PII DB off a non-rooted device | — | `AndroidManifest.xml:35` | **High** |
| M-4 | **Verbose logging ships in release** — iOS 82 unguarded `print()` incl. login response body (may contain tokens), GPS, email; Android `minifyEnabled false` so `Log.*` not stripped | `KinematicApp.swift:2728,2695,272` | `build.gradle:63-68`, `KinematicRepository.kt:607,1005` | Med–High |
| M-5 | **No TLS certificate pinning** for `api.kinematicapp.com` | no `URLSessionDelegate` | no `CertificatePinner` | Medium |
| M-6 | Password-reset **token over custom URL scheme** (hijackable by another app) → migrate to Universal / verified App Links | `KinematicApp.swift:3084-3095` | `AndroidManifest.xml:62-87` | Low–Med |
| M-7 | No snapshot/backgrounding privacy overlay (iOS); widget receiver exported (Android); `isDemoMode` auth predicate togglable via `UserDefaults` (iOS) | | | Low |
| M-8 | Firebase API key in `google-services.json` (client identifier, restrict by SHA in GCP) | — | `app/google-services.json` | Low/Info |

**Fixes:** move `auth_token`/`refresh_token`/`session_id` to **iOS Keychain** (`…ThisDeviceOnly`) and **Android EncryptedSharedPreferences / Keystore**; encrypt offline caches (iOS `.completeFileProtection`, Android SQLCipher) and purge on logout; set Android `allowBackup="false"` (or exclude token/DB); enable R8 (`minifyEnabled true`) + strip logs; gate all `print`/`Log` behind DEBUG; add SPKI cert pinning with a backup pin.

**Verified secure (both):** ATS not weakened / no cleartext (iOS no `NSAppTransportSecurity` override; Android `cleartextTrafficPermitted=false`), all endpoints HTTPS; no `WKWebView`/no JS-bridge; no hardcoded backend/Supabase secrets in app source; HTTP body logging correctly gated to debug (Android).

---

## 7. GDPR / DPDP data-protection compliance

The platform processes a heavy PII footprint — lead/contact **identity + DOB + gender + address**,
continuous **employee GPS**, and **attendance selfies** — but has almost no data-protection
machinery. Notable bright spot: **call-recording consent is well modelled**
(`conversationIntel.service.ts` — `consent_captured`/`consent_method`/`consent_at`); replicate that pattern.

| # | Area | GDPR / DPDP | Sev | Evidence / status |
|---|---|---|---|---|
| PR-1 | **Public selfie & form-photo buckets** (world-readable, indefinite) | Art 5(1)(f), 9, 32 / §8(5) | **Critical** | `SECURITY.md` open item #3; `add_attendance_selfie_columns.sql` |
| PR-2 | **No data-subject / data-principal rights** (access, erasure, rectification, portability) | Art 12–20 / §11–13 | **Critical** | ABSENT — zero `gdpr/dsar/erasure/portability` hits; only an admin bulk CSV |
| PR-3 | **Soft-delete never purges PII** | Art 17, 5(1)(e) / §8(7) | **Critical** | `leads.service.ts:503-508`, `crud.service.ts:243-246` |
| PR-4 | **No retention policy / TTL / purge** (GPS, selfies, audit metadata) | Art 5(1)(e) / §8(7) | High | ABSENT — only a demo stub returns fake retention values |
| PR-5 | **No consent for primary flows** (lead PII collection, employee GPS, selfies) | Art 6/7/9 / §5–6 | High | Only marketing/WhatsApp opt-in booleans exist |
| PR-6 | **No privacy policy / notice / terms / DPA / ROPA** in any repo | Art 13/14/28/30 / §5 | High | ABSENT — only a placeholder consent string in the form builder |
| PR-7 | **No age-gating on DOB** (children's data) | Art 8 / §9 (verifiable parental consent <18) | High | `leads.service.ts:136`; no minor logic anywhere |
| PR-8 | **PII reads & bulk CSV exports unaudited** | Art 5(2), 30 / §8(4)(5) | High | `auditAll.ts:17` skips GET; export `crm.routes.ts:644` is a GET |
| PR-9 | **Cross-border transfer** — Indian personal data in Australia (Supabase `ap-southeast-2`), plus Railway/Vercel/Firebase (US) | Art 44–49 / §16 | High | **Region verified live: `ap-southeast-2`** |
| PR-10 | **Lead/contact PII sent to Anthropic** (scoring, NBA, card-scan images, call transcripts) — sub-processor + transfer | Art 28/44 / §8(2) | High | `leadScoring.service.ts:448`, `cardScan.service.ts`, `conversationIntel.service.ts:176` |
| PR-11 | Breach runbook not mapped to statutory notice (72h SA / DPB + principals); DPO alias is a placeholder | Art 33/34 / §8(6) | Medium | `SECURITY.md:2,108-138` |
| PR-12 | **Data minimization is UI-only** — hidden built-in fields still accepted/stored server-side | Art 5(1)(c), 25 / §6(1) | Medium | overrides hide DOB/gender but `leads.service.ts:136` persists regardless |
| PR-13 | **No DPIA** for GPS + selfies + AI profiling (high-risk processing) | Art 35, 22 / §10 | Medium | ABSENT |

---

## 8. `SECURITY.md` claim scorecard (tested against code)

| Claim | Status |
|---|---|
| Helmet CSP/HSTS/nosniff/frameguard/COOP | **TRUE** |
| Body caps 2 MB / 256 KB, strict JSON; slowloris timeouts; proto-pollution guard | **TRUE** |
| Error responses sanitised (no stack/SQL to client) | **TRUE** |
| Signed-upload cheque/POD URL validation; no SSRF | **TRUE** |
| Per-route rate limits (auth/gstin/uploads/salesman); trust-proxy correct | **TRUE** |
| RLS deny-by-default | **TRUE** (live-verified) |
| "Vercel previews opt-in via `CORS_ALLOW_VERCEL_PREVIEWS`" | **FALSE** — flag not in code; previews always allowed (C1) |
| Login = composite (IP+email) limiter | **OVERSTATED** — degrades to IP-only (R-1) |
| Password policy "digit + alpha, no 3+ repeats" | **OVERSTATED** — no digit+alpha rule; threshold is 4+ repeats |
| Logs redact password/token/secret | **PARTIAL** — credentials only; **PII not redacted** (P-2); query-string secrets logged (P-1) |
| "Secrets moved out of code" | **FALSE** — Firebase key committed (S-1) |
| Selfie/form-photo buckets should be private | **STILL PUBLIC** (PR-1) |
| HIBP leaked-password check | **OFF on both prod projects** (live-verified) |
| Dockerfile build-args leak Supabase keys | **UNVERIFIABLE** — no Dockerfile in repo (Nixpacks build); check `docker history` on the real image |

---

## 9. Prioritized remediation roadmap

**P0 — before any pen-test / compliance test (Critical, mostly fast):**
1. **Rotate the Firebase key**, remove `firebase_b64.txt`, purge from git history (S-1).
2. **Fix the cross-tenant IDOR** — AND `org_id` + validate `client_id` ownership at all ~15 sites (C-1).
3. **Make selfie/form-photo buckets private** + serve via signed URLs (PR-1).
4. **Turn on HIBP** leaked-password protection in both Supabase projects.
5. **Remove/gate the demo super-admin token** and `demo@` elevation (H-1).

**P1 — high (weeks):**
6. Ship a **privacy policy + DPDP §5 notice + consent capture** for lead collection and employee monitoring; execute **DPAs** + maintain a **ROPA** and sub-processor register incl. Anthropic (PR-5/6/10).
7. Build **DSAR / erasure / portability** endpoint and wire **true PII purge** behind it (PR-2/3).
8. **Age-gate DOB** for children's-data rules (PR-7).
9. Tighten **CORS** patterns (C1); fix **login limiter** ordering (R-1); redact **query-string secrets + PII** in logs/`audit_log` (P-1/P-2); **audit PII reads/exports** (PR-8).
10. **Mobile:** move tokens to Keychain/EncryptedSharedPreferences; disable Android backup + encrypt caches (M-1/2/3). **Web:** get refresh token + CRM PII out of `localStorage` (W-1/2).

**P2 — medium (this quarter):**
11. Define + enforce a **retention schedule + purge job** (PR-4); enforce field-overrides server-side (PR-12); **DPIA** for GPS/selfies/AI (PR-13); statutory **breach-notification playbook** + real DPO alias (PR-11).
12. Magic-byte upload validation + stream large uploads (U-1); commit **lockfile** + upgrade multer/firebase-admin/Next.js (D-1/2/W-5); nonce-based **CSP** (W-3/4); add web `middleware.ts` (W-6); **cert pinning** on mobile (M-5).
13. Confirm **data residency** requirement for Tata (India vs Australia) and document transfer basis (PR-9).

**P3 — hardening/hygiene:** JWT `aud`/`iss` (M-3); `search_path` on `current_org_id`; extensions out of `public`; delete dead `errorHandler` (E-1); shared sanitiser on activity search (L-1); OAuth-state hard-fail (S-2); kill `--force` deploy (DP-1); restrict mobile Firebase/Maps API keys; Universal/App Links for reset (M-6).

---

## 10. What could not be verified (state honestly to auditors)
- Live exploitability of C-1 against a second real org (code-path is unambiguous; no DB write test run).
- Whether any DPA / privacy-policy documents exist **off-repo** (none in code — absence here is the finding).
- Anthropic contract terms (retention / no-training).
- Whether Railway's Nixpacks image bakes build-time env into layers (check `docker history`).
- Whether `DEMO_ORG_ID` ever contains real rows in production.
