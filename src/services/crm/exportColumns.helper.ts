/**
 * Auto-discovers the column set for a CRM CSV export from a sample row
 * (whatever the listLeads / listDeals / etc. service returned). Adding a
 * new field via migration shows up in the next CSV pull automatically —
 * no code change needed beyond the exclude list below.
 *
 * Caller stamps any UUID columns with hydrated *_name equivalents
 * (owner_name, source_name, etc.) before passing rows in here; the
 * hydrated keys appear in the column set, the raw UUIDs are excluded.
 */

// Internal / system / security-sensitive columns we never want in a CSV.
const EXCLUDE_KEYS = new Set<string>([
  // Tenant / row identity.
  'id', 'org_id', 'client_id',
  // Soft-delete + audit columns.
  'deleted_at',
  // Hashed lookup helpers (security-sensitive).
  'email_hash', 'phone_hash',
  // Internal jsonb + computed fields (custom_fields is flattened to
  // custom__<key> columns separately so the raw blob isn't needed).
  'score_breakdown', 'next_action_ai', 'custom_fields',
  // Raw UUIDs — surfaced via *_name hydration columns instead.
  'owner_id', 'source_id', 'created_by', 'updated_by',
  'latest_update_by', 'assignment_rule_id', 'territory_id',
  'converted_contact_id', 'converted_account_id', 'converted_deal_id',
  // Internal timestamps that don't help a CSV consumer.
  'score_updated_at', 'next_action_updated_at',
]);

// Friendly labels for snake_case keys. snake_case → "Title Case" is the
// default; this map handles the cases where Title Case looks wrong
// (acronyms, abbreviations, brand names).
const LABEL_OVERRIDES: Record<string, string> = {
  utm_source: 'UTM Source',
  utm_medium: 'UTM Medium',
  utm_campaign: 'UTM Campaign',
  utm_term: 'UTM Term',
  utm_content: 'UTM Content',
  is_b2c: 'Is B2C',
  is_converted: 'Is Converted',
  whatsapp_consent: 'WhatsApp Consent',
  marketing_consent: 'Marketing Consent',
  date_of_birth: 'Date of Birth',
  address_line1: 'Address Line 1',
  address_line2: 'Address Line 2',
  postal_code: 'Postal Code',
  preferred_contact_method: 'Preferred Contact Method',
  alternate_mobiles: 'Alternate Mobiles',
  referrer_url: 'Referrer URL',
  landing_page: 'Landing Page',
  photo_url: 'Photo URL',
};

function toTitle(key: string): string {
  if (LABEL_OVERRIDES[key]) return LABEL_OVERRIDES[key];
  return key.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

export interface ExportCol {
  key: string;
  label: string;
}

// Preferred ordering up-front so the most important fields appear in the
// first columns of every CSV (first_name, last_name, contact info, status,
// score, owner). Anything not in this list lands after, in the order it
// appeared on the sample row.
const PREFERRED_ORDER = [
  'first_name', 'last_name', 'email', 'phone', 'alternate_mobiles',
  'company', 'title', 'industry',
  'address_line1', 'address_line2', 'city', 'district', 'block',
  'state', 'postal_code', 'country',
  'status', 'lifecycle_stage', 'is_b2c', 'is_converted',
  'score', 'score_grade', 'owner_name', 'source_name',
  'last_activity_at', 'last_contacted_at', 'stage_changed_at',
  'latest_update', 'latest_update_at', 'latest_update_by_name',
  'updates_history',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'referrer_url', 'landing_page',
  'tags', 'interests', 'notes',
  'date_of_birth', 'gender',
  'preferred_contact_method', 'marketing_consent', 'whatsapp_consent',
  'photo_url',
  'won_reason', 'won_at', 'lost_reason', 'disqualified_at',
  'first_response_at', 'converted_at',
  'created_at', 'updated_at',
];

/**
 * Build the ordered {key, label} list for the CSV from the sample row.
 * Rows are the hydrated objects after stampOwnerNames + stampSourceNames
 * + stampCustomFieldValues etc. — any synthetic columns the caller added
 * (owner_name, source_name, latest_update_by_name, custom__<key>) are
 * picked up automatically.
 */
export function discoverExportColumns(sampleRow: Record<string, unknown> | undefined | null): ExportCol[] {
  if (!sampleRow) return [];
  const keys = Object.keys(sampleRow).filter((k) => !EXCLUDE_KEYS.has(k));
  const inPreferred = new Set(PREFERRED_ORDER);
  const ordered: string[] = [];
  for (const k of PREFERRED_ORDER) if (keys.includes(k)) ordered.push(k);
  for (const k of keys) if (!inPreferred.has(k)) ordered.push(k);
  return ordered.map((k) => ({ key: k, label: toTitle(k) }));
}
