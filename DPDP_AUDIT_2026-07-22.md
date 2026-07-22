# Kinematic Platform — DPDP Act 2023 Compliance Audit

> **Date:** 2026-07-22 · **Regime:** India **Digital Personal Data Protection Act, 2023** (DPDP)
> **Scope:** Backend API (`Kinematic`), Web dashboard (`kinematic-dashboard`), iOS (`Kinematic-iOS`),
> Android (`Kinematic-App`), and both Supabase production projects
> (`clldjlojtmrrpozydqxk` "Kinematic-Production", `lnvxqjqfsxvtjvbzphou` Tata/"Kaiyo Technology Labs").
> **Method:** Static code review with `file:line` citations across all four repos, plus **live**
> read-only checks of Supabase storage-bucket privacy, region, and security advisors on both prod projects.
>
> This is a **dedicated DPDP audit** and supersedes §7 of `SECURITY_AUDIT_2026-07.md` (2026-07-13),
> which combined GDPR/DPDP/VAPT. The platform has **materially matured** in the nine days since that
> report — several of its Criticals are now fully or partly remediated (see §2). Where a prior claim or
> a `SECURITY.md` statement was found stale against current code or live infra, it is called out.

---

## 1. Roles & applicability

- **Data Fiduciary:** Kaiyo Technology Labs / Kinematic (operator of the platform and both tenants).
- **Data Principals:** (a) **CRM leads & contacts** — external individuals, incl. B2C retail consumers of
  Tata Tiscon; (b) **field-staff employees** whose GPS, attendance selfies and telemetry are processed.
  Neither group has a self-service login into the CRM — all rights tooling is operated by tenant staff.
- **Processors / sub-processors:** Supabase (DB/Auth/Storage, **AU**), Railway (API, US), Vercel (web, US),
  Firebase/FCM (US), **Anthropic** (AI, US), **Sarvam AI** (speech-to-text → Azure), plus GSTIN / e-invoice GSPs.
- **High-risk processing present** (relevant to §10 SDF / DPIA): continuous employee geolocation, facial
  attendance selfies, and automated AI profiling of individuals.

---

## 2. Executive summary

**Overall DPDP posture: Not yet compliant, but the gap has narrowed from "privacy-unready" to
"privacy-scaffolded-but-not-wired."** The platform now has genuine data-protection *machinery* — a DSAR
export/erase service, a retention purge job, server-side data-minimisation, private storage buckets, mobile
token encryption, a named Grievance Officer, a public privacy page and a draft compliance pack. The failing
theme is no longer *absence* — it is that the machinery is **half-wired, default-off, admin-only, or
documented-but-unenforced**. Lawful processing (notice + consent) at the point of collection remains the
foundational gap.

### What improved since 2026-07-13 (verified)
| Prior Critical/High | Status now | Evidence |
|---|---|---|
| Public selfie / form-photo buckets (was **Critical**) | **Remediated (live)** — all buckets `public:false` on both prod projects | live `storage.buckets` query; `media.controller.ts:52-76` signed URLs |
| No DSAR / access / erasure (was **Critical**) | **Present (admin-only)** — real export + column-level purge | `src/services/crm/dsar.service.ts`; `crm.routes.ts:4783-4810` |
| UI-only data minimisation (was Medium) | **Remediated for built-in fields** — server strips hidden fields pre-persist | `crm.routes.ts:390-427,697,1263` |
| No privacy policy / ROPA / DPA / notice (was High) | **Drafted** — `compliance/` pack + public privacy page | `Kinematic/compliance/*`; `kinematic-dashboard/src/app/privacy/page.tsx` |
| Mobile plaintext token at rest (was High) | **Remediated** — iOS Keychain, Android AES-GCM + `allowBackup=false` | `KeychainTokenStore.swift`; `KinematicRepository.kt:238-243`; `AndroidManifest.xml:43-44` |
| DB advisors (HIBP off, mutable search_path) | **Cleared** — only `extension_in_public` warnings remain | live advisors, both projects |

### Verdict by obligation
| DPDP obligation | Verdict | Headline |
|---|---|---|
| §5 Notice | **Fail** | Privacy notice exists but is **orphaned** — no collection flow shows/links it |
| §6/§7 Consent & lawful basis | **Fail** | No principal-facing consent for lead PII / GPS / selfies; only staff-ticked marketing booleans |
| §8(2) Processors | **Partial/Fail** | Draft register; **no executed DPAs**; **Sarvam AI undisclosed** |
| §8(3) Accuracy | **Partial** | Correction + audit trail exist; no email/phone verification |
| §8(5) Security | **Partial (good)** | Strong perimeter, private buckets, RLS; residual: audit-log PII, half-migrated public-URL code |
| §8(6) Breach notice | **Fail** | Ops runbook has no Board / Data-Principal notification step |
| §8(7) Retention/erasure | **Fail** | Purge job **default-off & unscheduled**; soft-delete default; selfies/recordings/GPS never purged |
| §9 Children | **Fail** | DOB collected + AI-profiled with **zero** age-gating or parental consent |
| §11 Access | **Partial** | Real export, but **admin-only** (no data-principal self-service); omits recipients |
| §12 Correction/Erasure | **Partial/Fail** | Real erase exists but admin-only; default delete is soft-delete; no correction-request flow |
| §13 Grievance | **Partial** | Named Officer + web page; email-only, not in mobile apps, notice still DRAFT |
| §14 Nomination | **Fail** | Right asserted in policy, **not implemented** anywhere |
| §16 Cross-border | **Fail** | Indian PII in Australia + US processors, **no established transfer basis** |

### Findings by severity
| Severity | Count | Examples |
|---|---|---|
| **Critical** | 2 | No notice/consent at collection (§5/§6); storage-limitation failure — purge off + soft-delete (§8(7)/§12) |
| **High** | 5 | Cross-border no basis (§16); Sarvam undisclosed + no DPAs (§8(2)); no child age-gate (§9); no self-service rights (§11/§12); no consent withdrawal (§6(4)) |
| **Medium** | 8 | Half-migrated public-URL code; audit-log PII; breach runbook; accuracy/verification; custom-field minimisation; §14 nomination; §13 surfacing; draft-only compliance pack |
| **Low** | 3 | Web `localStorage` token; iOS UserDefaults fallback residuals; no central log PII scrubber |

---

## 3. Live infrastructure posture (verified 2026-07-22, read-only)

| Check | Result |
|---|---|
| Supabase region (both projects) | **`ap-southeast-2` (Sydney, Australia)** — Indian personal data at rest offshore (§16) |
| Storage buckets (both projects) | **All `public:false`** — `kinematic-selfies`, `kinematic-form-photos`, `kinematic-avatars`, `kinematic-materials`, `distribution`, `conversation-audio` |
| RLS | **Deny-by-default across 95 tables** on both projects (fail-closed; backend uses service-role) |
| Security advisors | Only `extension_in_public` (WARN) remains on both; prior `function_search_path_mutable` and leaked-password warnings **cleared** |

> **Reconciliation note:** `SECURITY.md:100` and `src/controllers/upload.controller.ts:57` (`getPublicUrl`)
> still describe/emit *public* selfie & form-photo buckets. **This is stale** — the buckets are private in
> both live projects. The residual is a **code/doc-consistency bug** (uploads hand out non-functional public
> URLs; a signed-URL path exists at `media.controller.ts:52-76`), not a live data-exposure Critical.
> Downgraded accordingly (Finding S-1).

---

## 4. Personal-data inventory (data map)

| Category | Where (table → columns) | Evidence |
|---|---|---|
| Lead identity (B2C) | `crm_leads` → first/last name, email, phone, company, title | `migration_crm.sql:140-182`; `leads.service.ts:140-168` |
| **DOB (sensitive)** | `crm_leads.date_of_birth`, `crm_contacts.date_of_birth` | `migration_crm.sql:160,126` |
| **Gender (sensitive)** | `crm_leads.gender`, `crm_contacts.gender` | `migration_crm.sql:161,127` |
| Lead address / geo | `crm_leads` → address_line1/2, city, state, postal_code, country, district, block | `migration_crm.sql:162-168` |
| **Precise lead geolocation** | `crm_leads.latitude, longitude` | `migrations/crm_leads_add_lat_long.sql:13-17` |
| Contact / account identity | `crm_contacts`, `crm_accounts` → name, email, phone, mobile, address, linkedin | `migration_crm.sql:73-135` |
| Marketing / consent flags | `crm_leads` → marketing_consent, whatsapp_consent, preferred_contact_method, alternate_mobiles[] | `migration_crm.sql:168-170` |
| **Employee GPS trail** | `work_activity` → user_id, lat, lng, battery, captured_at | `migration_live_tracking.sql:1-20` |
| **Last-known employee location** | `users` → last_latitude, last_longitude, last_location_updated_at | `migration_live_tracking.sql:19-24` |
| Visit / SOS geo | `visit_logs`, `security_alerts`, `sos_alerts` | `retention.service.ts:27` |
| **Attendance selfies (biometric-adjacent)** | `attendance` → checkin_selfie_url, checkout_selfie_url | `add_attendance_selfie_columns.sql:4-9` |
| **Form submissions w/ photo + GPS** | `form_submissions` → latitude, longitude, photo_url (may hold PAN/Aadhaar card photos) | `add_form_submission_tracking_columns.sql:2-6`; `utils/demo/insuranceField.ts:202-203` |
| **Call recordings + transcripts** | `conversation_recordings` → audio_path (private bucket), transcript | `migrations/conversation_intelligence.sql:11-34` |
| Derived identifiers | `crm_leads.phone_hash, email_hash` | `dsar.service.ts:22-23` |

**Special / sensitive categories:** DOB, gender, precise geolocation (lead + continuous employee GPS),
facial attendance selfies, ID-card photos, and recorded call audio + transcripts.

---

## 5. Findings by obligation

### §5 — Notice at/before collection — **FAIL (Critical, combined with §6)**
- **N-1 (Critical):** The lead-create flows collect name, phone, email, DOB, gender, address and precise GPS
  with **no notice** describing data / purpose / rights / how to complain to the Data Protection Board, and
  no link to the privacy page. Web: `kinematic-dashboard/src/app/dashboard/crm/leads/new/page.tsx:446-483`;
  mobile: `Kinematic-App/.../crm/LeadCreateScreen.kt`, `Kinematic-iOS/.../CRM/LeadCreateView.swift`.
- **N-2 (Critical):** A well-drafted public privacy page **exists but is orphaned** —
  `kinematic-dashboard/src/app/privacy/page.tsx` includes a §5 collection-notice block (`:417-437`), rights,
  Grievance Officer and DPB reference, yet **nothing links to it** (login `login/page.tsx:489` only links
  forgot-password; no nav/form/mobile reference — content search found only the page itself). The org's own
  draft `compliance/DPDP_NOTICE.md:3-8` requires the notice be "shown/linked at every collection point"; the
  code does not do this.
- **N-3 (High):** iOS GPS + selfie capture has only OS permission strings (`Kinematic-iOS/.../Info.plist:38-43`)
  — no in-app §5 notice and no equivalent to Android's disclosure dialog (see G-2).

### §6 / §7 — Consent & lawful basis — **FAIL (Critical)**
- **C-1 (Critical):** No principal-facing, itemised, pre-processing consent for collecting lead PII, employee
  GPS or selfies. The lead form's "Consent" section (`leads/new/page.tsx:749-760`) contains **only**
  `marketing_consent` / `whatsapp_consent` checkboxes — marketing opt-ins, **toggled by staff**, not the data
  principal → not "free, specific, informed, unambiguous, clear affirmative action" under §6(1).
- **C-2 (High):** Marketing/WhatsApp consent stores **no who/when/method** — bare booleans
  (`migration_crm.sql:117-118` leads, `:169-170` contacts). Cannot demonstrate consent (§6(1)/accountability).
- **C-3 (High):** **No self-serve consent withdrawal / consent manager** (§6(4)-(6)). Withdrawal is documented
  as "email the Grievance Officer" (`privacy/page.tsx:433-434`) — not "as easy as giving it." An email-only
  unsubscribe route exists (`src/routes/crm/email-unsubscribe.routes.ts`) but withdraws *marketing email
  only*, not consent generally; flags are staff-editable only (`LeadEditScreen.kt:97-98`).
- **C-4 (Medium — §7 basis mismatch):** The policy bases employee GPS/selfie monitoring on "legitimate
  interests" (`privacy/page.tsx:213-219`). **DPDP has no "legitimate interests" ground** — re-ground on the
  §7 employment "legitimate use" limb and still provide §5 in-app notice before tracking.

### §8(2) — Processors engaged under contract — **PARTIAL / FAIL**
- **P-1 (High):** **Sarvam AI is an undisclosed sub-processor.** Conversation Intelligence sends raw customer
  **call audio** to Sarvam (STT, uploaded to **Azure** blob) then the transcript onward —
  `src/services/crm/ai/conversationIntel.service.ts:19,90-122`; `src/services/integrations/sarvam.ts`. Sarvam
  appears **nowhere** in `compliance/SUBPROCESSORS.md` or `ROPA.md` (0 matches) — a §8(2) transparency gap and
  an undocumented cross-border/hosting path.
- **P-2 (Medium):** Sub-processor register, ROPA and DPA all exist but are **unsigned DRAFTS with TODOs** —
  `compliance/SUBPROCESSORS.md` (GSTIN / e-invoice rows `TODO`), `DPA_TEMPLATE.md` ("do not execute as-is"),
  Anthropic zero-retention terms "TODO: obtain" (`SUBPROCESSORS.md:14`). **No executed DPAs** anywhere.
- **P-3 (info):** PII actually transmitted to **Anthropic (US)**: lead identity fields
  (`leadScoring.service.ts:444-461`), full base64 **business-card images** (`cardScan.service.ts:54-72`), call
  **transcripts** + lead context (`conversationIntel.service.ts:122,164-174`). No zero-retention/no-training
  header set on any call.

### §8(3) — Accuracy — **PARTIAL**
- **A-1 (good):** Correction with audit trail — `updateLead` writes `crm_lead_history` old→new + `changed_by`
  (`leads.service.ts:442-496`); dedup on email/phone prevents duplicates (`leads.service.ts:28-43`).
- **A-2 (Medium):** **No verification** of PII correctness — no email/phone OTP or `verified_at` columns
  anywhere; phone is regex-shape-only (`crm.validators.ts:97`). City can be silently inferred from the
  *creator's* profile rather than the subject (`leads.service.ts:67-77`), risking inaccurate location data.

### §8(5) — Reasonable security safeguards — **PARTIAL (largely good)**
- **S-1 (Medium, downgraded from Critical):** Storage buckets are **private (live-verified)**, but the code is
  **half-migrated**: `upload.controller.ts:57` still returns `getPublicUrl` and `SECURITY.md:100` still lists
  the buckets as public. Fix: switch uploads to the signed-URL path (`media.controller.ts:52-76`) and correct
  the doc. (No live exposure — see §3 reconciliation.)
- **S-2 (Medium):** **PII in `audit_log.metadata.summary` in plaintext.** The `after` body is well-redacted
  (`auditAll.ts:38-45` masks email/phone/dob/aadhaar/pan/geo), but `extractSummary()` runs on the **raw** body
  and `SUMMARY_KEYS` includes `email`/`phone` (`auditAll.ts:114,191,234`) — writing them cleartext, bypassing
  the redaction; name/company/city also retained.
- **S-3 (Low):** App logs largely mitigated — morgan logs method+URL, query-string secrets redacted
  (`app.ts:237-241`); no central Winston PII scrubber across 428 log sites (ad-hoc risk).
- **S-4 (Low):** Token-at-rest: **web** stores `kinematic_token` in `localStorage` (XSS-readable,
  `kinematic-dashboard/src/lib/supabase.ts:47`); **Android/iOS remediated** (AES-GCM / Keychain), but iOS has
  residual plaintext-`UserDefaults` **fallback reads** (`CRMService.swift:648` and 4 others) — low risk
  (only if Keychain empty), remove them.
- **Verified good:** RLS deny-by-default (95 tables, live); Android `allowBackup=false` + encrypted DataStore;
  iOS Keychain `…ThisDeviceOnly`; private buckets; improved DB advisors.

### §8(6) — Personal-data-breach notification — **FAIL**
- **B-1 (Medium):** The operational breach runbook (`SECURITY.md:108-138`) is **purely technical** (rotate
  keys, lock users) with **no step** to notify the **Data Protection Board of India** or affected **Data
  Principals** and no timeline. Statutory notification exists only in **DRAFT** docs
  (`PRIVACY_POLICY.md:104-108`, `DPA_TEMPLATE.md:53-57`), unwired to ops. Add Board + principal notification
  steps with timelines to the actual runbook.

### §8(7) — Storage limitation / erasure on purpose completion — **FAIL (Critical)**
- **R-1 (Critical):** **Personal data is effectively never erased in production.** The retention purge is a
  **dry-run unless `RETENTION_PURGE_ENABLED=true`** (`retention.service.ts:70-72`) and **no `cron.schedule`
  invokes it** (only lead-rescore is scheduled; the purge edge function merely *says* it "should" be scheduled
  — `supabase/functions/crm-purge-retention/index.ts:3-9`). Combined with **soft-delete-only defaults** across
  leads/contacts/deals/accounts/activities (`crud.service.ts:243-250`; `leads.service.ts:507-510`;
  contacts/deals/accounts/activities controllers), PII persists indefinitely.
- **R-2 (High):** Even if enabled, the purge **excludes** the most sensitive categories: attendance selfies,
  `form_submissions` photos, `conversation_recordings`, and the continuous **employee GPS trail**
  (`work_activity` is explicitly retained — `retention.service.ts:25-27`) plus `users.last_lat/long`. These
  accrue forever.
- **R-3 (Medium):** Storage **objects** (selfie/audio/card blobs) are not deleted by any job or by DSAR erase
  — only DB URL columns are nulled, orphaning the underlying files.

### §9 — Children's personal data — **FAIL**
- **CH-1 (High):** **Zero age-gating.** DOB is validated, persisted, imported, exported and fed to AI scoring
  for **any** individual with no age computation or minor detection anywhere (searched `isMinor`/`calculateAge`/
  `under18`/`guardian`/`parental` across all repos — absent). Persist path: `leads.service.ts:140`; bulk import
  `import.service.ts:286`; some tenants mark DOB **required** (`utils/demo/insuranceCrm.ts:465`).
- **CH-2 (High):** **No verifiable parental/guardian consent** mechanism (§9(1)) — the only "consent"
  primitives are the marketing booleans, not verifiable, not parental, not age-linked.
- **CH-3 (High):** **AI profiling applies to minors with no carve-out** (§9(3) tracking/behavioural
  monitoring; §9(4) targeted advertising). Every lead — including a B2C minor — is auto-scored and re-scored
  from activity and externally profiled by Anthropic (`leads.service.ts:83,513-537`;
  `leadScoring.service.ts:435-461`), weighing "engagement" and "consent flags," with no age exclusion.
- Protections exist only as **unenforced prose** (`compliance/PRIVACY_POLICY.md:56-61`; `privacy/page.tsx:257-263`).

### §11 — Right to access information about processing — **PARTIAL**
- **AC-1 (present, admin-only):** `exportSubject()` assembles a machine-readable JSON bundle of the subject's
  lead/contact rows + child tables (`dsar.service.ts:131-160`; `GET /crm/gdpr/export`,
  `crm.routes.ts:4783-4795`), tenant-scoped and audited. **But** it is gated to
  `super_admin/admin/main_admin` (`crm.routes.ts:4810`) — **no data-principal self-service** (High, shared
  with §12).
- **AC-2 (Medium):** The bundle **omits §11(b) recipients** — it returns the subject's own rows only, not the
  processors/third parties the data was shared with.
- The admin bulk-CSV lead export (`crm.routes.ts:719-863`) is internal staff reporting, **not** an access path.

### §12 — Correction & erasure — **PARTIAL / FAIL**
- **E-1 (Critical, = R-1):** The **default** product "delete" is **soft-delete only** — PII retained
  (`crud.service.ts:243-250`; `leads.service.ts:507-510`; deals/contacts/accounts/activities controllers).
- **E-2 (present, admin-only):** A **genuine** erasure path exists — `eraseSubject()` nulls identifier/sensitive
  columns (`LEAD_PII_COLUMNS`/`CONTACT_PII_COLUMNS`, incl. email/phone/DOB/lat/long/photo_url/hashes) and
  hard-deletes free-text child rows (`dsar.service.ts:162-208`; `POST /crm/gdpr/erase`) — **good**, but
  admin-only and scoped to lead/contact data (misses employee selfies/GPS/`form_submissions` and storage blobs).
- **E-3 (High):** **No correction-request flow** for data principals — correction is staff-CRUD only; no
  `correct`/`rectify` endpoint despite the policy claiming DSR tooling handles it.
- **E-4 (High):** No end-user "delete my account / my data" surface in web or either mobile app.

### §13 — Grievance redressal — **PARTIAL**
- **G-1 (present):** A **named Grievance Officer** is published and consistent — *Sagar Bhargava,
  s@kinematicapp.com, +91 8802274880* (`compliance/DPDP_NOTICE.md:29-30`, `PRIVACY_POLICY.md:83,112`;
  `privacy/page.tsx:346,429`, with DPB-of-India reference).
- **G-2 (Medium):** **Not a data-principal channel in-product** — the app's `grievances` feature is an
  **HR/employee** channel (harassment/pay/supervisor; `grievance.controller.ts:9-16`, `requireAuth`),
  **distinct** from DPDP. Redressal for external principals is **email-only**, not surfaced in either mobile
  app (0 hits for privacy/grievance strings in `.swift`/`.kt`), and the notice is still marked **DRAFT**
  (`DPDP_NOTICE.md:3`).

### §14 — Right to nominate — **FAIL**
- **NM-1 (Medium):** The right is **asserted** in policy (`PRIVACY_POLICY.md:81`, `DPDP_NOTICE.md:28`) but
  **not implemented** — no nominee table/column/endpoint/UI anywhere (only an unrelated demo KYC form field).
  Documentation-vs-implementation mismatch.

### §16 — Cross-border transfer — **FAIL**
- **T-1 (High):** All CRM PII, selfies, GPS history and credentials sit in **Supabase `ap-southeast-2`
  (Australia)** (live-verified §3); US processors receive data in transit (Railway/Vercel/Firebase/Anthropic);
  Sarvam audio → Azure (region undocumented). **No established transfer basis** — every SCC/adequacy entry in
  `SUBPROCESSORS.md` / `DPA_TEMPLATE.md:48-51` reads "confirm with counsel," and an India-region evaluation is
  an open TODO (`SUBPROCESSORS.md:24-25`; `ROPA.md:69-71`). No data localisation for any Indian tenant.

### §10 — Significant Data Fiduciary / DPIA (if notified) — **gap**
- **D-1 (Medium):** High-risk processing (continuous GPS + facial selfies + automated AI profiling) has **no
  completed DPIA** — `ROPA.md` marks DPIAs "required" for RPA-2/3/5 but none are done. Prepare DPIAs now in
  case the org is notified as an SDF, and appoint a DPO (currently a Grievance Officer only).

---

## 6. Good patterns to preserve & replicate

- **G-1 — Call-recording consent (the model to copy platform-wide):** bilingual EN/HI ask, affirmative switch
  gating Start, persisted record (who/when/method), and **server-side enforcement** that refuses processing
  without it — `RecordCallSheet.kt:56-59,213-216`; `conversation_intelligence.sql:18-21`;
  `conversationIntel.service.ts:62,76` (`throw AppError(400,'Consent not captured')`); consent badge in web UI.
  **Replicate this pattern for lead-PII collection, GPS and selfies.**
- **G-2 — Android location prominent-disclosure dialog** before the permission request
  (`LocationDisclosureDialog.kt:31-126`; `MainActivity.kt:151-198`) — closest thing to at-collection notice;
  port to iOS and persist as a consent record.
- **Server-side hidden-field stripping** (`stripHiddenLeadFields`, `crm.routes.ts:390-427,697,1263`) — genuine
  minimisation of built-in fields; extend to custom fields.
- **DSAR export + real column-level erase**, audited (`dsar.service.ts`) — expose via a data-principal surface.
- Private buckets, RLS deny-by-default, mobile token encryption, named Grievance Officer, public privacy page.

---

## 7. Prioritized remediation roadmap

**P0 — lawful-processing & storage-limitation (foundational, blocks compliance):**
1. **Wire the §5 notice** — link/show the privacy page at every collection point (web + mobile lead/contact
   create, GPS, selfie) (N-1/N-2/N-3).
2. **Add principal-facing consent** at primary collection, modelled on the call-recording pattern (G-1);
   record who/when/method/purpose; make consent **withdrawable in-app** (C-1/C-2/C-3).
3. **Turn on retention** — set `RETENTION_PURGE_ENABLED=true`, **schedule** the purge (pg_cron → edge fn), and
   **extend coverage** to selfies, recordings, form photos and the employee GPS trail; delete storage objects,
   not just URL columns (R-1/R-2/R-3, E-1).

**P1 — rights, processors, transfer, children:**
4. Expose **data-principal self-service** access/correction/erasure (or a trackable request intake), add a
   **correction-request** flow, and include **recipient disclosure** in the export (AC-1/AC-2/E-3/E-4).
5. **Disclose Sarvam** in the register/ROPA; **execute DPAs** (Supabase, Railway, Vercel, Firebase, Anthropic,
   Sarvam) incl. Anthropic zero-retention/no-training terms; publish the compliance pack out of DRAFT
   (P-1/P-2/P-3).
6. Establish a **§16 transfer basis** (SCCs or India-region Supabase) and document it (T-1).
7. **Age-gate DOB** — compute age, block/flag minors, require verifiable parental consent, and **exclude
   minors from AI profiling** (CH-1/CH-2/CH-3).

**P2 — hardening & hygiene:**
8. Switch uploads to signed URLs + fix `SECURITY.md` (S-1); stop writing email/phone to
   `audit_log.metadata.summary` (S-2); add Board + Data-Principal steps to the breach runbook (B-1).
9. Strip **hidden custom fields** server-side + set a minimisation default (custom-field gap); add email/phone
   **verification** (A-2); **implement §14 nomination** or stop asserting it (NM-1); surface grievance/privacy
   in mobile apps (G-2 §13).
10. Move web token off `localStorage` (S-4); remove iOS UserDefaults fallbacks; add a central log PII scrubber
    (S-3); complete **DPIAs** for GPS/selfies/AI and appoint a DPO (D-1).

---

## 8. What could not be verified (state honestly)
- Whether `RETENTION_PURGE_ENABLED` is set and the purge is actually scheduled in the production environment
  (env/cron not readable from code — R-1 assumes worst case from committed config).
- Whether any **executed** DPAs or a signed privacy notice exist **off-repo** (none in code — the drafts are the finding).
- Anthropic / Sarvam contractual retention & no-training terms.
- Live exploit testing was **not** performed (static + read-only DB checks only); no DB writes or MITM.
- iOS UserDefaults fallback reachability confirmed only by code path, not runtime.
