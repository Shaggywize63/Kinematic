# Kinematic — Data-Protection Compliance Pack (DRAFT templates)

> **These are working DRAFTS, not legal advice.** They were generated from the
> platform's actual data flows (see `SECURITY_AUDIT_2026-07.md`) to give the
> legal team a concrete, accurate starting point. Every `[BRACKETED]` value is a
> placeholder you must fill in, and the whole pack must be reviewed and adopted
> by a qualified data-protection lawyer before it is published or relied on.

| File | Purpose | Framework |
|---|---|---|
| `PRIVACY_POLICY.md` | Public-facing privacy policy | GDPR Art. 13/14, DPDP §5 |
| `DPDP_NOTICE.md` | Short itemised notice shown at point of collection | DPDP §5 |
| `ROPA.md` | Record of Processing Activities (internal register) | GDPR Art. 30 |
| `SUBPROCESSORS.md` | Sub-processor register | GDPR Art. 28(2), DPDP §8(2) |
| `DPA_TEMPLATE.md` | Data Processing Agreement template for customers | GDPR Art. 28, DPDP §8 |

## How to adopt this pack
1. Fill every `[PLACEHOLDER]` (legal entity, addresses, DPO contact, grievance
   officer, jurisdiction, exact retention periods once agreed).
2. Confirm the factual claims against reality — hosting regions, the live
   sub-processor list, whether lead/contact PII is actually sent to the AI
   features, and whether selfies/photos have been made private (audit PR-1).
3. Have counsel review; publish the privacy policy at a stable URL and link the
   DPDP notice from every collection form (web + mobile).
4. Wire the data-subject-rights flow to the DSAR endpoints built in this PR
   (`/api/v1/crm/gdpr/export`, `/erase`) so requests are actioned, not just promised.

## Key facts these documents rely on (verified during the audit)
- **Personal data processed:** lead/contact identity (name, phone, email, DOB,
  gender, address, city/state/country), field-staff **GPS location history**,
  and **attendance selfies / form photos**.
- **Hosting region:** Supabase (Postgres/Auth/Storage) in **ap-southeast-2
  (Sydney, Australia)** for both tenants — a cross-border transfer for Indian
  personal data (DPDP §16 / GDPR Ch. V).
- **Sub-processors:** Supabase, Railway, Vercel, Google Firebase (FCM),
  Anthropic (AI features), plus optional GSTIN-verification and e-invoice/e-way
  GSP providers. See `SUBPROCESSORS.md`.
