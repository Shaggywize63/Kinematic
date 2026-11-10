// PORT of kinematic-dashboard src/lib/hrms/format.ts (the payroll oracle). Exact parity is the requirement: do NOT "improve" the maths here.
// Change the dashboard file first, regenerate tests/fixtures/hrms-payroll-golden.json, and port the change; tests/hrmsPayrollParity.test.ts
// reproduces every golden case. Only imports (and the masking helper's location) differ from the original.

// Formatting helpers for the HRMS pages (Indian number system, dates, months).

const INR = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const INR2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 1234567 → "₹12,34,567" */
export const inr = (n: number | null | undefined): string => (n == null || Number.isNaN(n) ? '—' : `${n < 0 ? '-' : ''}₹${INR.format(Math.abs(Math.round(n)))}`);
/** With paise: 1234.5 → "₹1,234.50" */
export const inr2 = (n: number | null | undefined): string => (n == null || Number.isNaN(n) ? '—' : `${n < 0 ? '-' : ''}₹${INR2.format(Math.abs(n))}`);
/** Plain grouped number, no symbol. */
export const num = (n: number | null | undefined): string => (n == null || Number.isNaN(n) ? '—' : INR.format(Math.round(n)));
/** Lakhs for headline numbers: 1850000 → "₹18.5L", 25000000 → "₹2.5Cr". */
export function inrShort(n: number): string {
  const a = Math.abs(n);
  const s = n < 0 ? '-' : '';
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2).replace(/\.?0+$/, '')}Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2).replace(/\.?0+$/, '')}L`;
  if (a >= 1e3) return `${s}₹${(a / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return `${s}₹${Math.round(a)}`;
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function below1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} Hundred`); n %= 100; }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '')); }
  else if (n > 0) parts.push(ONES[n]);
  return parts.join(' ');
}
/** 125000 → "Rupees One Lakh Twenty Five Thousand Only" (Indian grouping). */
export function inrWords(amount: number): string {
  let n = Math.round(Math.abs(amount));
  if (n === 0) return 'Rupees Zero Only';
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push(`${below1000(crore)} Crore`);
  if (lakh) parts.push(`${below1000(lakh)} Lakh`);
  if (thousand) parts.push(`${below1000(thousand)} Thousand`);
  if (n) parts.push(below1000(n));
  return `Rupees ${parts.join(' ')} Only`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-10-05" → "5 Oct 2026". Returns "—" for empty. */
export function fmtDate(d?: string | null): string {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  if (!y || !m || !day) return d;
  return `${day} ${MONTHS[m - 1]} ${y}`;
}
/** "2026-10" → "Oct 2026" */
export function fmtMonth(m?: string | null): string {
  if (!m) return '—';
  const [y, mo] = m.split('-').map(Number);
  return y && mo ? `${MONTHS[mo - 1]} ${y}` : m;
}
export function fmtMonthLong(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return `${MONTHS_LONG[mo - 1]} ${y}`;
}
export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${fmtDate(iso.slice(0, 10))}, ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
}

export const todayISO = (): string => new Date().toISOString().slice(0, 10);
export const currentMonth = (): string => todayISO().slice(0, 7);
export function addMonths(m: string, delta: number): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}
export function daysInMonth(m: string): number {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
export function addDays(d: string, n: number): string {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
export function diffDays(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000);
}
/** Whole years and months between two dates → { years, months }. */
export function tenure(from: string, to: string = todayISO()): { years: number; months: number; totalMonths: number } {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  months = Math.max(0, months);
  return { years: Math.floor(months / 12), months: months % 12, totalMonths: months };
}
/** Indian financial year of a month: "2026-11" → { label: "FY 2026-27", start: "2026-04", end: "2027-03" } */
export function financialYear(m: string): { label: string; start: Month; end: Month; monthsElapsed: number; monthsLeft: number } {
  const [y, mo] = m.split('-').map(Number);
  const startYear = mo >= 4 ? y : y - 1;
  const elapsed = mo >= 4 ? mo - 4 + 1 : mo + 9;
  return {
    label: `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`,
    start: `${startYear}-04`,
    end: `${startYear + 1}-03`,
    monthsElapsed: elapsed,
    monthsLeft: 12 - elapsed + 1,
  };
}
type Month = string;

export const fullName = (e: { firstName: string; lastName: string }): string => `${e.firstName} ${e.lastName}`.trim();
export const initials = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
export const pct = (n: number, digits = 0): string => `${n.toFixed(digits)}%`;
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
export const round0 = (n: number): number => Math.round(n);
