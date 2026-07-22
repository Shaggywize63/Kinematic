# Sub-processor Register — Kinematic App

> **DRAFT — verify every row before publishing.** GDPR Art. 28(2)/(4) & DPDP
> §8(2) require you to maintain, and make available to customers, the list of
> sub-processors who process personal data on your behalf. Publish a customer-
> facing copy at https://kinematicapp.com/privacy and notify customers of changes.

| Sub-processor | Service provided | Personal data processed | Region / location | Transfer safeguard |
|---|---|---|---|---|
| **Supabase** | Managed Postgres, Auth, Storage | All CRM PII, GPS, selfies/photos, credentials | **ap-southeast-2 (Sydney, Australia)** | Standard Contractual Clauses (confirm with counsel) |
| **Railway** | Backend API hosting (Express) | All data in transit through the API | United States | Standard Contractual Clauses (confirm with counsel) |
| **Vercel** | Web dashboard hosting | Data rendered in the dashboard; technical/usage | United States (edge/global) | Standard Contractual Clauses (confirm with counsel) |
| **Google Firebase (FCM)** | Push notifications | Device tokens, notification content | Google global | Google Cloud Data Processing Terms / SCCs |
| **Anthropic** | AI features (lead scoring, summaries, business-card scan, call intelligence) | **Lead/contact context, card images, call transcripts** — confirm exact fields and minimise | United States | DPA + zero-retention/no-training terms — **TODO: obtain from Anthropic** |
| **Sarvam AI** | Speech-to-text (Saarika) for Conversation Intelligence — transcribes recorded customer calls with speaker diarization | **Recorded call audio + resulting transcript** (may contain names, phone numbers, spoken commercial terms) | India (api.sarvam.ai); batch jobs stage audio in **Azure Blob Storage** — confirm Azure region | Data Processing Agreement + retention/deletion terms — **TODO: obtain from Sarvam** |
| ****TODO: confirm GSTIN-verification vendor, or remove if not used**** | GST number verification | Business identifiers (GSTIN, legal name) | India | Data Processing Agreement |
| ****TODO: confirm e-invoice/e-way GSP vendor, or remove if not used**** | Statutory e-invoicing | Invoice/party details | India | Data Processing Agreement |

## DPDP §16 — cross-border transfer basis (interim)
DPDP §16 permits transfer of personal data outside India except to countries the
Central Government restricts by notification (none material at the time of
writing). **Interim basis, pending counsel sign-off:** transfers to the
sub-processors above are governed by each provider's **Standard Contractual
Clauses / Data Processing Terms**, which every executed DPA below must
incorporate. This is an **interim** position — replace "confirm with counsel"
in the table once each DPA is signed, and re-evaluate if any transfer
restriction is notified. For tenants with a data-localisation requirement (e.g.
a Tata contractual/regulatory mandate), provision an **India-region Supabase
project** and route that tenant to it rather than relying on the transfer basis.

## Action items before this is accurate
1. **Confirm each region** from the provider console (Supabase region is verified
   as ap-southeast-2; **Sarvam's Azure staging region needs confirming**; the rest
   need confirming).
2. **Confirm what the AI features actually send to Anthropic and Sarvam** and
   minimise/redact PII in prompts/audio metadata; obtain zero-retention /
   no-training contractual terms.
3. **Sign a DPA / addendum with each** sub-processor (incl. **Sarvam**) and store
   the executed copy; confirm each DPA incorporates SCCs/transfer terms (§16).
4. Confirm whether any Indian personal data must stay in India for DPDP §16 and,
   if so, provision an India-region Supabase project for the affected tenant.
