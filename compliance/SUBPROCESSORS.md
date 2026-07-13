# Sub-processor Register — [PRODUCT/BRAND NAME]

> **DRAFT — verify every row before publishing.** GDPR Art. 28(2)/(4) & DPDP
> §8(2) require you to maintain, and make available to customers, the list of
> sub-processors who process personal data on your behalf. Publish a customer-
> facing copy at [SUB-PROCESSOR URL] and notify customers of changes.

| Sub-processor | Service provided | Personal data processed | Region / location | Transfer safeguard |
|---|---|---|---|---|
| **Supabase** | Managed Postgres, Auth, Storage | All CRM PII, GPS, selfies/photos, credentials | **ap-southeast-2 (Sydney, Australia)** | [SCCs / adequacy — confirm] |
| **Railway** | Backend API hosting (Express) | All data in transit through the API | [US / region — confirm] | [SCCs] |
| **Vercel** | Web dashboard hosting | Data rendered in the dashboard; technical/usage | [US / edge] | [SCCs] |
| **Google Firebase (FCM)** | Push notifications | Device tokens, notification content | Google global | [SCCs / Google DPA] |
| **Anthropic** | AI features (lead scoring, summaries, business-card scan, call intelligence) | **Lead/contact context, card images, call transcripts** — confirm exact fields and minimise | [US] | [DPA + zero-retention/no-training terms — confirm] |
| **[GSTIN verification provider]** | GST number verification | Business identifiers (GSTIN, legal name) | [India] | [DPA] |
| **[e-Invoice / e-Way GSP]** | Statutory e-invoicing | Invoice/party details | [India] | [DPA] |

## Action items before this is accurate
1. **Confirm each region** from the provider console (Supabase region is verified
   as ap-southeast-2; the rest need confirming).
2. **Confirm what the AI features actually send to Anthropic** and minimise/redact
   PII in prompts; obtain zero-retention / no-training contractual terms.
3. **Sign a DPA / addendum with each** sub-processor and store the executed copy.
4. Decide whether any Indian personal data must stay in India for DPDP §16 and,
   if so, evaluate an India-region Supabase project for the affected tenant.
