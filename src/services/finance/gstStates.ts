// GST state / UT codes (place of supply). Keep in sync with the dashboard's src/lib/gstStates.ts.
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory', '99': 'Other Country',
};

export function stateLabel(code?: string | null): string {
  if (!code) return '';
  const c = String(code).trim().padStart(2, '0');
  return GST_STATES[c] ? `${c}-${GST_STATES[c]}` : String(code);
}

// Two-letter postal abbreviations used by accounting exports (Zoho writes e.g. "KA" for Karnataka).
const STATE_ABBREVIATIONS: Record<string, string> = {
  JK: '01', HP: '02', PB: '03', CH: '04', UT: '05', UK: '05', HR: '06', DL: '07', RJ: '08', UP: '09', BR: '10', SK: '11',
  AR: '12', NL: '13', MN: '14', MZ: '15', TR: '16', ML: '17', AS: '18', WB: '19', JH: '20', OR: '21', OD: '21', CG: '22', CT: '22',
  MP: '23', GJ: '24', DD: '26', DN: '26', MH: '27', KA: '29', GA: '30', LD: '31', KL: '32', TN: '33', PY: '34',
  AN: '35', TS: '36', TG: '36', AP: '37', LA: '38',
};

/**
 * Resolve whatever an export put in a "place of supply" / state cell to a 2-digit GST code:
 * "29", "[29] - Karnataka", "29-Karnataka", "KA", "Karnataka". Returns null when unrecognised.
 */
export function stateCodeFromText(raw?: string | null): string | null {
  if (!raw) return null;
  const t = String(raw).trim();
  if (!t) return null;
  const lead = /^\[?\s*(\d{1,2})\s*\]?(?:\s*[-:)]|\s|$)/.exec(t);
  if (lead) { const c = lead[1].padStart(2, '0'); if (GST_STATES[c]) return c; }
  const up = t.toUpperCase();
  if (STATE_ABBREVIATIONS[up]) return STATE_ABBREVIATIONS[up];
  const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
  const want = norm(t.replace(/^\[?\d{1,2}\]?\s*[-:]?\s*/, ''));
  if (!want) return null;
  const hit = Object.entries(GST_STATES).find(([, name]) => norm(name) === want);
  return hit ? hit[0] : null;
}
