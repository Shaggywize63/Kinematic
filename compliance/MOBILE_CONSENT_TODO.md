# Mobile consent parity — implementation spec (DPDP §5/§6)

> **Status: NOT YET IMPLEMENTED — requires a build-capable environment.**
> The web dashboard and backend consent chain are live (crm_consents ledger,
> `/api/v1/crm/consent`, `_consent` accepted on lead/contact create). iOS + Android
> must reach parity. These native changes were **deliberately not made blind** —
> they touch SwiftUI/Compose UI and (Android) a typed Gson model that cannot be
> compiled/verified in the docs environment. Implement + verify via fastlane CI.

## Backend contract (already live)
- Lead/contact **create** accepts an optional block:
  `"_consent": { "consented": bool, "method": "in_app", "notice_version": "2026-07-22" }`
  → recorded in `crm_consents` (purpose `lead_pii`).
- **Withdrawal / status:** `GET /api/v1/crm/consent?subject_type=lead&subject_id=<id>`,
  `POST /api/v1/crm/consent/withdraw { id }`.
- Per-tenant hard gate: `crm_settings.config.consent.lead_pii.required` → create 400s
  `CONSENT_REQUIRED` without affirmative consent. Default record-only.

## iOS (`Kinematic-iOS`) — LOW risk (dictionary body)
1. **Create view** (`Views/CRM/LeadCreateView.swift`, `ContactCreateView.swift`):
   add a "Data Collection & Consent" section — a short notice (Text) + link to the
   privacy page + a `Toggle` bound to `@State private var dataConsent = false`.
   Mirror Android's `LocationDisclosureDialog` wording.
2. **ViewModel** (`ViewModels/CRM/LeadsViewModel.swift` ~L159, where `body` is built):
   add `body["_consent"] = ["consented": dataConsent, "method": "in_app", "notice_version": "2026-07-22"]`.
   Body is already `[String: Any]` — no Codable change needed.
3. **Detail** (`Views/CRM/LeadDetailView.swift`, `ContactDetailView.swift`): a small
   consent section that GETs `/crm/consent` and offers a Withdraw button
   (`POST /crm/consent/withdraw`).
4. Add a §5 notice screen before GPS/selfie capture (iOS currently has only the
   Info.plist permission strings).

## Android (`Kinematic-App`) — MODERATE risk (typed Gson model)
1. **Model** (`data/model/CrmLead.kt` or the create DTO): add
   `@SerializedName("_consent") val consent: ConsentInput? = null` and a
   `data class ConsentInput(val consented: Boolean, val method: String = "in_app", @SerializedName("notice_version") val noticeVersion: String = "2026-07-22")`.
   Gson omits null fields by default → safe when unset; ignored on response deserialize.
2. **Create screen** (`ui/crm/LeadCreateScreen.kt`, `ContactCreateScreen.kt`): add a
   consent `Checkbox` + notice, generalize the existing
   `screens/LocationDisclosureDialog.kt` into a reusable data-collection notice;
   set `consent = ConsentInput(consented = ...)` when building the `CrmLead`.
3. **Detail** (`LeadDetailScreen.kt` / `ContactDetailScreen.kt`): consent status +
   Withdraw button hitting `/crm/consent` + `/crm/consent/withdraw` (add the two
   calls to `CrmApiService.kt` + repository).
4. Surface the privacy policy + Grievance Officer somewhere in-app (§13) — currently
   zero references in the app.

## Verification (must pass before merge)
- iOS: fastlane build (Xcode 26) green; create a lead with the toggle on/off and
  confirm a `crm_consents` row appears (or doesn't) accordingly.
- Android: `./gradlew :app:compileDebugKotlin` green; same round-trip check.
- Both: confirm the per-tenant hard gate blocks create when enabled.
