# Record of Processing Activities (ROPA) — Kaiyo Technology Labs

> **DRAFT — GDPR Art. 30 / DPDP accountability.** Internal register; review at
> least annually and whenever a processing activity changes. Fill placeholders.

**Controller:** Kaiyo Technology Labs, F-2587, 4th Floor, Ansal Esencia, Sector 67, Gurugram, Haryana 122101, India.
**DPO / Grievance Officer:** Sagar Bhargava, s@kinematicapp.com, 8802274880.
**Last reviewed:** 13 July 2026.

---

### RPA-1 — CRM lead & contact management
- **Role:** Processor (on behalf of business customers, who are controllers).
- **Purpose:** Store and manage prospect/customer records; sales workflow.
- **Data subjects:** Leads, contacts (external individuals).
- **Categories:** Name, phone, email, company, title; optionally DOB, gender,
  address, city/state/country; tags, notes, engagement history, custom fields.
- **Recipients:** Supabase (hosting), the customer's authorised staff.
- **Storage/region:** Supabase, ap-southeast-2 (Sydney).
- **Retention:** Life of customer relationship; soft-deleted rows purged after
  90 days (see retention job).
- **Security:** TLS, tenant isolation, RLS, audit log, field-level PII masking
  in logs. **Lawful basis:** Contract / controller instruction.

### RPA-2 — Field-staff attendance & selfies
- **Role:** Processor. **Purpose:** Attendance verification.
- **Data subjects:** Employees/field staff of customers.
- **Categories:** Check-in/out timestamps, **attendance selfies** (facial image).
- **Recipients:** Supabase Storage. **Region:** Sydney.
- **Retention:** 180 days. **Risk:** biometric-adjacent — buckets MUST be private
  (audit PR-1). **Lawful basis:** Employment/legitimate interest + **DPIA**.

### RPA-3 — Field-staff location tracking
- **Role:** Processor. **Purpose:** Live tracking, route/visit verification,
  geo-fence checks during working hours.
- **Categories:** Precise GPS (lat/long) history, battery, device metadata.
- **Retention:** 180 days (location trim job). **Lawful basis:** Legitimate
  interest + **DPIA**; in-app notice before tracking.

### RPA-4 — Forms & activity capture
- **Purpose:** Capture visits, form submissions, photos, orders.
- **Categories:** Address, GPS, photos, submitted field values.
- **Retention:** 180 days. **Lawful basis:** Contract / notified purpose.

### RPA-5 — AI features (profiling)
- **Purpose:** Lead scoring, next-best-action, summaries, business-card OCR,
  call-recording intelligence.
- **Categories:** Lead/contact context, card images, call transcripts, **recorded
  call audio**.
- **Recipients:** **Anthropic (US)** (scoring/summaries/transcript analysis) and
  **Sarvam AI** (speech-to-text; audio staged in **Azure Blob Storage**) — both
  sub-processors.
- **Notes:** Automated processing → provide **opt-out** and human review; confirm
  no solely-automated decisions with legal effect (GDPR Art. 22). Minimise PII in
  prompts. **Children (DPDP §9): minors are excluded from AI scoring / LLM
  reranking (`is_minor` gate).** **Lawful basis:** Legitimate interest.

### RPA-6 — Notifications
- **Purpose:** Push/email notifications. **Categories:** Device tokens, email,
  message content. **Recipients:** Firebase/FCM, email provider.

### RPA-7 — Security, audit & accountability
- **Purpose:** Authn/authz, fraud/geo-fence flags, immutable audit logging,
  DSAR handling. **Categories:** User IDs, roles, IP, user-agent, action logs
  (PII values masked). **Retention:** 365 days.

### RPA-8 — Account & billing (own controller data)
- **Role:** Controller. **Purpose:** Manage customer accounts, tax/e-invoicing.
- **Recipients:** **TODO: confirm GSTIN-verification vendor, or remove if not used**, **TODO: confirm e-invoice/e-way GSP vendor, or remove if not used**, payment/billing. **Region:** India.

---
## Cross-cutting
- **International transfers:** Sydney hosting (Supabase) + US sub-processors
  (Anthropic, Firebase, Railway, Vercel) + Sarvam (India / Azure staging).
  **DPDP §16 interim basis:** provider SCCs / Data Processing Terms incorporated
  into each DPA (see `SUBPROCESSORS.md`); India-region Supabase for any
  data-localisation-bound tenant. Confirm with counsel.
- **DPIA required for:** RPA-2 (selfies), RPA-3 (GPS), RPA-5 (AI profiling).
- **Children (DPDP §9):** age derived from DOB at capture (`is_minor`); minors
  excluded from AI profiling/LLM reranking; verifiable parental consent required
  before processing a child's data.
- **Data-subject requests:** actioned via `/api/v1/crm/gdpr/export` and `/erase`;
  consent captured/withdrawn via `/api/v1/crm/consent` (crm_consents ledger).
