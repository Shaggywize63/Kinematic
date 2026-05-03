/**
 * Indian state / UT codes used in GSTIN's first two digits.
 *
 * Source: CBIC GST state-code list. The FK on every party (brand, distributor,
 * outlet) is the 2-char string code — we never store the name, only the code,
 * so the map is canonical here.
 */

export interface StateRow {
  code: string;          // 2-digit state code (leading char of GSTIN)
  name: string;          // display name
  abbr: string;          // ISO-style 2-3 letter abbreviation
  is_active: boolean;    // false for retired codes (kept for legacy data)
}

export const INDIA_STATES: StateRow[] = [
  { code: '01', name: 'Jammu & Kashmir',                 abbr: 'JK', is_active: true },
  { code: '02', name: 'Himachal Pradesh',                abbr: 'HP', is_active: true },
  { code: '03', name: 'Punjab',                          abbr: 'PB', is_active: true },
  { code: '04', name: 'Chandigarh',                      abbr: 'CH', is_active: true },
  { code: '05', name: 'Uttarakhand',                     abbr: 'UT', is_active: true },
  { code: '06', name: 'Haryana',                         abbr: 'HR', is_active: true },
  { code: '07', name: 'Delhi',                           abbr: 'DL', is_active: true },
  { code: '08', name: 'Rajasthan',                       abbr: 'RJ', is_active: true },
  { code: '09', name: 'Uttar Pradesh',                   abbr: 'UP', is_active: true },
  { code: '10', name: 'Bihar',                           abbr: 'BR', is_active: true },
  { code: '11', name: 'Sikkim',                          abbr: 'SK', is_active: true },
  { code: '12', name: 'Arunachal Pradesh',               abbr: 'AR', is_active: true },
  { code: '13', name: 'Nagaland',                        abbr: 'NL', is_active: true },
  { code: '14', name: 'Manipur',                         abbr: 'MN', is_active: true },
  { code: '15', name: 'Mizoram',                         abbr: 'MZ', is_active: true },
  { code: '16', name: 'Tripura',                         abbr: 'TR', is_active: true },
  { code: '17', name: 'Meghalaya',                       abbr: 'ML', is_active: true },
  { code: '18', name: 'Assam',                           abbr: 'AS', is_active: true },
  { code: '19', name: 'West Bengal',                     abbr: 'WB', is_active: true },
  { code: '20', name: 'Jharkhand',                       abbr: 'JH', is_active: true },
  { code: '21', name: 'Odisha',                          abbr: 'OD', is_active: true },
  { code: '22', name: 'Chhattisgarh',                    abbr: 'CG', is_active: true },
  { code: '23', name: 'Madhya Pradesh',                  abbr: 'MP', is_active: true },
  { code: '24', name: 'Gujarat',                         abbr: 'GJ', is_active: true },
  { code: '25', name: 'Daman & Diu',                     abbr: 'DD', is_active: false },
  { code: '26', name: 'Dadra & Nagar Haveli and Daman & Diu', abbr: 'DN', is_active: true },
  { code: '27', name: 'Maharashtra',                     abbr: 'MH', is_active: true },
  { code: '29', name: 'Karnataka',                       abbr: 'KA', is_active: true },
  { code: '30', name: 'Goa',                             abbr: 'GA', is_active: true },
  { code: '31', name: 'Lakshadweep',                     abbr: 'LD', is_active: true },
  { code: '32', name: 'Kerala',                          abbr: 'KL', is_active: true },
  { code: '33', name: 'Tamil Nadu',                      abbr: 'TN', is_active: true },
  { code: '34', name: 'Puducherry',                      abbr: 'PY', is_active: true },
  { code: '35', name: 'Andaman & Nicobar Islands',       abbr: 'AN', is_active: true },
  { code: '36', name: 'Telangana',                       abbr: 'TS', is_active: true },
  { code: '37', name: 'Andhra Pradesh',                  abbr: 'AP', is_active: true },
  { code: '38', name: 'Ladakh',                          abbr: 'LA', is_active: true },
  { code: '97', name: 'Other Territory',                 abbr: 'OT', is_active: true },
  { code: '99', name: 'Centre Jurisdiction',             abbr: 'CJ', is_active: true },
];

const BY_CODE = new Map(INDIA_STATES.map((s) => [s.code, s]));

export function stateName(code: string | null | undefined): string | null {
  if (!code) return null;
  return BY_CODE.get(code)?.name ?? null;
}

// ── GSTIN format & checksum ─────────────────────────────────────────────────
// Format: NNAAAAANNNN APN[1Z]Z[A0-9]
//   2-digit state code | 5-letter PAN prefix | 4-digit PAN sequence |
//   1 PAN-checksum letter | 1 entity code | "Z" | 1 alnum checksum
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function charValue(c: string): number {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  return c.charCodeAt(0) - 55;            // 'A' = 10 ... 'Z' = 35
}
function valueChar(v: number): string {
  return v < 10 ? String(v) : ALPHA[v - 10];
}

/**
 * GSTIN check-digit using mod-36 weighted sum (factor alternates 1, 2; >35 wraps).
 * Returns the expected check character; compare with gstin.charAt(14).
 */
function gstinCheckChar(gstin14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const factor = i % 2 === 0 ? 1 : 2;
    let prod = charValue(gstin14[i]) * factor;
    prod = Math.floor(prod / 36) + (prod % 36);
    sum += prod;
  }
  const remainder = sum % 36;
  const check = (36 - remainder) % 36;
  return valueChar(check);
}

export interface GstinParse {
  valid: boolean;
  reason?: 'format' | 'checksum' | 'unknown_state';
  gstin?: string;
  state_code?: string;
  state_name?: string;
  pan?: string;             // characters 3..12 of the GSTIN
}

export function parseGstin(input: string | null | undefined): GstinParse {
  if (!input) return { valid: false, reason: 'format' };
  const gstin = String(input).trim().toUpperCase();
  if (!GSTIN_RE.test(gstin)) return { valid: false, reason: 'format', gstin };

  // Checksum
  const expected = gstinCheckChar(gstin.slice(0, 14));
  if (expected !== gstin[14]) return { valid: false, reason: 'checksum', gstin };

  // State derivation
  const state_code = gstin.slice(0, 2);
  const sName = stateName(state_code);
  if (!sName) return { valid: false, reason: 'unknown_state', gstin, state_code };

  return {
    valid: true,
    gstin,
    state_code,
    state_name: sName,
    pan: gstin.slice(2, 12),
  };
}
