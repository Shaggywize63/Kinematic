# Record of Processing Activities (ROPA) — [LEGAL ENTITY NAME]

> **DRAFT — GDPR Art. 30 / DPDP accountability.** Internal register; review at
> least annually and whenever a processing activity changes. Fill placeholders.

**Controller:** [LEGAL ENTITY NAME], [ADDRESS], [COUNTRY].
**DPO / Grievance Officer:** [NAME, EMAIL, PHONE].
**Last reviewed:** [DATE].

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
  [90] days (see retention job).
- **Security:** TLS, tenant isolation, RLS, audit log, field-level PII masking
  in logs. **Lawful basis:** Contract / controller instruction.

### RPA-2 — Field-staff attendance & selfies
- **Role:** Processor. **Purpose:** Attendance verification.
- **Data subjects:** Employees/field staff of customers.
- **Categories:** Check-in/out timestamps, **attendance selfies** (facial image).
- **Recipients:** Supabase Storage. **Region:** Sydney.
- **Retention:** [period]. **Risk:** biometric-adjacent — buckets MUST be private
  (audit PR-1). **Lawful basis:** Employment/legitimate interest + **DPIA**.

### RPA-3 — Field-staff location tracking
- **Role:** Processor. **Purpose:** Live tracking, route/visit verification,
  geo-fence checks during working hours.
- **Categories:** Precise GPS (lat/long) history, battery, device metadata.
- **Retention:** [180] days (location trim job). **Lawful basis:** Legitimate
  interest + **DPIA**; in-app notice before tracking.

### RPA-4 — Forms & activity capture
- **Purpose:** Capture visits, form submissions, photos, orders.
- **Categories:** Address, GPS, photos, submitted field values.
- **Retention:** [period]. **Lawful basis:** Contract / notified purpose.

### RPA-5 — AI features (profiling)
- **Purpose:** Lead scoring, next-best-action, summaries, business-card OCR,
  call-recording intelligence.
- **Categories:** Lead/contact context, card images, call transcripts.
- **Recipients:** **Anthropic (US)** — sub-processor.
- **Notes:** Automated processing → provide **opt-out** and human review; confirm
  no solely-automated decisions with legal effect (GDPR Art. 22). Minimise PII in
  prompts. **Lawful basis:** Legitimate interest.

### RPA-6 — Notifications
- **Purpose:** Push/email notifications. **Categories:** Device tokens, email,
  message content. **Recipients:** Firebase/FCM, email provider.

### RPA-7 — Security, audit & accountability
- **Purpose:** Authn/authz, fraud/geo-fence flags, immutable audit logging,
  DSAR handling. **Categories:** User IDs, roles, IP, user-agent, action logs
  (PII values masked). **Retention:** [365] days.

### RPA-8 — Account & billing (own controller data)
- **Role:** Controller. **Purpose:** Manage customer accounts, tax/e-invoicing.
- **Recipients:** [GSTIN provider], [GSP], payment/billing. **Region:** [India].

---
## Cross-cutting
- **International transfers:** Sydney hosting + US sub-processors (Anthropic,
  Firebase, possibly Railway/Vercel) → SCCs/adequacy required; DPDP §16 review
  for Indian data.
- **DPIA required for:** RPA-2 (selfies), RPA-3 (GPS), RPA-5 (AI profiling).
- **Data-subject requests:** actioned via `/api/v1/crm/gdpr/export` and `/erase`.
