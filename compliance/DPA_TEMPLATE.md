# Data Processing Agreement (DPA) — TEMPLATE

> **DRAFT for legal review — do not execute as-is.** This template governs
> processing where **Kaiyo Technology Labs** ("Processor") processes personal data
> on behalf of a customer ("Controller / Data Fiduciary") using the Kinematic
> platform. It is intended to satisfy GDPR Art. 28 and DPDP §8. Attach as an
> addendum to the master services agreement.

## 1. Roles
The Controller determines the purposes and means of processing the personal data
it enters into the Service. The Processor processes that personal data **only on
the Controller's documented instructions**, including for international transfers,
unless required by law (in which case it will inform the Controller unless legally
prohibited).

## 2. Subject-matter & details (Annex mirrors ROPA)
- **Subject-matter:** provision of the Kinematic CRM / field-force Service.
- **Duration:** the term of the services agreement.
- **Nature & purpose:** storage, organisation, retrieval, transmission, and (for
  AI features) analysis of personal data to deliver the Service.
- **Categories of data subjects & data:** as set out in `ROPA.md` (leads,
  contacts, employees; identity, contact, demographic, location, images,
  commercial, technical).

## 3. Processor obligations
The Processor shall:
(a) process only on documented instructions;
(b) ensure persons authorised to process are bound by confidentiality;
(c) implement appropriate technical & organisational security measures (Annex B);
(d) engage **sub-processors** only under (4);
(e) assist the Controller, taking into account the nature of processing, with
    data-subject requests (Art. 12–23 / DPDP §11–14) — the Service provides
    export and erasure tooling for this;
(f) assist with security, breach notification, DPIAs and prior consultation
    (Art. 32–36);
(g) at the Controller's choice, delete or return personal data at the end of the
    services and delete existing copies unless retention is legally required;
(h) make available information necessary to demonstrate compliance and allow for
    audits/inspections **TODO: agree audit scope & frequency**.

## 4. Sub-processors
The Controller provides **general authorisation** for the sub-processors listed
in `SUBPROCESSORS.md`. The Processor will inform the Controller of intended
changes and give the Controller the opportunity to object within **30 days**.
Each sub-processor is bound by data-protection terms no less protective than
this DPA.

## 5. International transfers
Where processing involves transfer outside India, the parties rely on
Standard Contractual Clauses (confirm with counsel), incorporated by
reference. Current hosting region: **Australia — Supabase ap-southeast-2 (Sydney)**.

## 6. Personal-data breach
The Processor shall notify the Controller **without undue delay (target: within
48 hours)** after becoming aware of a personal-data breach, with the
information the Controller needs to meet its own notification duties (GDPR Art.
33/34; DPDP §8(6) — Data Protection Board of India + affected principals).

## 7. Liability, term, governing law
As per the master services agreement. Governing law: **India**.

---
### Annex A — Processing details
See `ROPA.md`.

### Annex B — Technical & organisational measures (summary)
Encryption in transit (TLS 1.2+); tenant isolation & row-level security;
role-based access control; rate limiting & brute-force protection; immutable,
PII-masked audit logging; secrets management; private storage for
sensitive images; data-subject export/erasure tooling; documented breach
response; least-privilege access; retention & purge automation.

*(Keep Annex B aligned with `../SECURITY.md` and `../SECURITY_AUDIT_2026-07.md`.)*
