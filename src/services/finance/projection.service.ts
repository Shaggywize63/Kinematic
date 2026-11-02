/**
 * Twelve-month billing projection, built from the invoices already in the books.
 *
 * Recurring revenue is DERIVED, not typed in. For each customer the cadence comes from, in order:
 *   1. the repeat schedule on their latest invoice ("repeat this invoice every …"),
 *   2. the longest billing duration on that invoice's lines (a 6-month line renews in 6 months),
 *   3. the gap pattern between their invoices (≈30 / 91 / 182 / 365 days).
 * A customer with none of these is a one-off and stays out of the run-rate.
 * The amount per billing cycle is the sum of that customer's invoices issued within half a cycle of
 * their latest one (so a monthly customer's older invoices are not double counted, while two invoices
 * raised for the same half-yearly cycle are). Everything is ex-GST (taxable value) — GST is not revenue.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { FinanceScope, scoped } from './scope';
import { round2 } from './money';
import { fetchAll } from './reports.service';
import { addDays, addInterval, addMonths, type RecurrenceSpec } from './recurrence';

const db = () => supabaseAdmin;
const REVENUE_STATUSES = ['sent', 'partially_paid', 'paid'];
const num = (v: unknown, d: number, min: number, max: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

export interface ProjInvoice {
  customer_id: string; customer: string; issue_date: string; taxable: number; total: number; balance: number; status: string;
  recurrence_enabled?: boolean; recurrence_interval?: string | null; recurrence_custom_every?: number | null; recurrence_custom_unit?: string | null;
  max_duration_months?: number | null;
}
export interface ProjQuote { number: string; customer_id: string; customer: string; taxable: number }
export interface ProjPayment { payment_date: string; amount: number }
export interface ProjOptions { churn_pct: number; growth: number; growth_up: number }
export const DEFAULT_OPTIONS: ProjOptions = { churn_pct: 15, growth: 2500, growth_up: 5000 };

type Source = 'schedule' | 'duration' | 'history';
const INTERVALS = new Set(['weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly', 'custom']);

const specDays = (s: RecurrenceSpec): number => {
  switch (s.interval) {
    case 'weekly': return 7;
    case 'monthly': return 30;
    case 'quarterly': return 91;
    case 'half_yearly': return 182;
    case 'yearly': return 365;
    default: return (s.customEvery ?? 1) * (s.customUnit === 'day' ? 1 : 30);
  }
};
const perYear = (s: RecurrenceSpec): number => {
  switch (s.interval) {
    case 'weekly': return 52;
    case 'monthly': return 12;
    case 'quarterly': return 4;
    case 'half_yearly': return 2;
    case 'yearly': return 1;
    default: return s.customUnit === 'day' ? 365 / (s.customEvery ?? 1) : 12 / (s.customEvery ?? 1);
  }
};
export const cadenceLabel = (s: RecurrenceSpec): string => {
  switch (s.interval) {
    case 'weekly': return 'Weekly';
    case 'monthly': return 'Monthly';
    case 'quarterly': return 'Quarterly';
    case 'half_yearly': return 'Half-yearly';
    case 'yearly': return 'Yearly';
    default: return `Every ${s.customEvery} ${s.customUnit === 'day' ? 'day' : 'month'}${(s.customEvery ?? 1) > 1 ? 's' : ''}`;
  }
};

/** A whole number of months → the matching preset, else a custom "every N months". */
function fromMonths(n: number): RecurrenceSpec {
  if (n === 1) return { interval: 'monthly' };
  if (n === 3) return { interval: 'quarterly' };
  if (n === 6) return { interval: 'half_yearly' };
  if (n === 12) return { interval: 'yearly' };
  return { interval: 'custom', customEvery: n, customUnit: 'month' };
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Cadence from the spacing of a customer's invoices (needs at least two invoices ≥10 days apart). */
function inferFromHistory(dates: string[]): RecurrenceSpec | null {
  const uniq = Array.from(new Set(dates)).sort();
  const gaps: number[] = [];
  for (let i = 1; i < uniq.length; i++) { const g = daysBetween(uniq[i - 1], uniq[i]); if (g >= 10) gaps.push(g); }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  const targets: Array<[number, RecurrenceSpec]> = [[30, { interval: 'monthly' }], [91, { interval: 'quarterly' }], [182, { interval: 'half_yearly' }], [365, { interval: 'yearly' }]];
  for (const [t, spec] of targets) if (Math.abs(median - t) <= t * 0.25) return spec;
  return null;
}

function specFor(latest: ProjInvoice, all: ProjInvoice[]): { spec: RecurrenceSpec; source: Source } | null {
  if (latest.recurrence_enabled && latest.recurrence_interval && INTERVALS.has(latest.recurrence_interval)) {
    const spec: RecurrenceSpec = { interval: latest.recurrence_interval as RecurrenceSpec['interval'] };
    if (spec.interval === 'custom') {
      if (!latest.recurrence_custom_every) return null;
      spec.customEvery = latest.recurrence_custom_every; spec.customUnit = latest.recurrence_custom_unit === 'day' ? 'day' : 'month';
    }
    return { spec, source: 'schedule' };
  }
  const dur = Math.round(Number(latest.max_duration_months) || 0);
  if (dur >= 1 && dur <= 120) return { spec: fromMonths(dur), source: 'duration' };
  const inferred = inferFromHistory(all.map((i) => i.issue_date));
  return inferred ? { spec: inferred, source: 'history' } : null;
}

export interface ProjCustomer {
  customer: string; cadence: string; source: Source; cycle_amount: number; per_year: number; share: number;
  last_invoice: string; next_billing: string; invoices_in_cycle: number;
}

export function buildProjection(
  invoices: ProjInvoice[], quotes: ProjQuote[], payments: ProjPayment[], asOf: string, opts: ProjOptions = DEFAULT_OPTIONS,
) {
  const rev = invoices.filter((i) => REVENUE_STATUSES.includes(i.status));
  const byCustomer = new Map<string, ProjInvoice[]>();
  for (const i of rev) { const l = byCustomer.get(i.customer_id) ?? []; l.push(i); byCustomer.set(i.customer_id, l); }

  const monthStart = `${asOf.slice(0, 7)}-01`;
  const horizonEnd = addDays(addMonths(monthStart, 12), -1);
  const monthKeys: string[] = Array.from({ length: 12 }, (_, k) => addMonths(monthStart, k).slice(0, 7));
  const contracted = new Array<number>(12).fill(0);

  const customers: ProjCustomer[] = [];
  const oneOff: Array<{ customer: string; amount: number; date: string }> = [];
  for (const list of byCustomer.values()) {
    list.sort((a, b) => a.issue_date.localeCompare(b.issue_date));
    const latest = list[list.length - 1];
    const found = specFor(latest, list);
    if (!found) { oneOff.push({ customer: latest.customer, amount: round2(list.reduce((x, i) => x + i.taxable, 0)), date: latest.issue_date }); continue; }
    const { spec, source } = found;
    const since = addDays(latest.issue_date, -Math.round(specDays(spec) / 2));
    const cycle = list.filter((i) => i.issue_date >= since);
    const cycleAmount = round2(cycle.reduce((x, i) => x + i.taxable, 0));
    let next = addInterval(latest.issue_date, spec);
    for (let guard = 0; next <= asOf && guard < 500; guard++) next = addInterval(next, spec);
    for (let d = next, guard = 0; d <= horizonEnd && guard < 500; d = addInterval(d, spec), guard++) {
      const k = monthKeys.indexOf(d.slice(0, 7));
      if (k >= 0) contracted[k] += cycleAmount;
    }
    customers.push({
      customer: latest.customer, cadence: cadenceLabel(spec), source, cycle_amount: cycleAmount, per_year: round2(cycleAmount * perYear(spec)),
      share: 0, last_invoice: latest.issue_date, next_billing: next, invoices_in_cycle: cycle.length,
    });
  }
  const arr = round2(customers.reduce((x, c) => x + c.per_year, 0));
  customers.forEach((c) => { c.share = arr > 0 ? Math.round((c.per_year / arr) * 1000) / 10 : 0; });
  customers.sort((a, b) => b.per_year - a.per_year);
  const top2 = arr > 0 ? (customers.slice(0, 2).reduce((x, c) => x + c.per_year, 0) / arr) : 0;

  // Open (sent) quotes, de-duplicated by customer + amount (a re-sent quote is not extra pipeline).
  const seen = new Set<string>(); const pipeline: Array<{ number: string; customer: string; amount: number }> = [];
  for (const q of quotes) { const key = `${q.customer_id}|${q.taxable}`; if (seen.has(key)) continue; seen.add(key); pipeline.push({ number: q.number, customer: q.customer, amount: round2(q.taxable) }); }
  const pipelineTotal = round2(pipeline.reduce((x, q) => x + q.amount, 0));

  const churn = Math.min(100, Math.max(0, opts.churn_pct)) / 100;
  let cC = 0, cB = 0, cU = 0;
  const months = monthKeys.map((key, k) => {
    const m = k + 1;
    const c = round2(contracted[k]);
    const conservative = round2(c * (1 - churn));
    const base = round2(c + opts.growth * m);
    const upside = round2(c + opts.growth_up * m + (m === 2 ? pipelineTotal : 0));
    cC += conservative; cB += base; cU += upside;
    const label = new Date(`${key}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    return { month: key, label, contracted: c, conservative, base, upside, cum_conservative: round2(cC), cum_base: round2(cB), cum_upside: round2(cU) };
  });

  // Actuals: billed (taxable) and collected, by month, from the first invoice to this month.
  const billedBy = new Map<string, number>(); const collectedBy = new Map<string, number>();
  for (const i of rev) billedBy.set(i.issue_date.slice(0, 7), (billedBy.get(i.issue_date.slice(0, 7)) ?? 0) + i.taxable);
  for (const p of payments) collectedBy.set(p.payment_date.slice(0, 7), (collectedBy.get(p.payment_date.slice(0, 7)) ?? 0) + p.amount);
  const first = Array.from(billedBy.keys()).sort()[0];
  const history: Array<{ month: string; label: string; billed: number; collected: number }> = [];
  if (first) {
    for (let k = 0, key = first; key <= asOf.slice(0, 7) && k < 60; k++, key = addMonths(`${key}-01`, 1).slice(0, 7)) {
      history.push({ month: key, label: new Date(`${key}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }), billed: round2(billedBy.get(key) ?? 0), collected: round2(collectedBy.get(key) ?? 0) });
    }
  }

  const taxable = rev.reduce((x, i) => x + i.taxable, 0), total = rev.reduce((x, i) => x + i.total, 0);
  const gstFactor = taxable > 0 ? Math.round((total / taxable) * 1000) / 1000 : 1;
  const sumOf = (k: 'conservative' | 'base' | 'upside' | 'contracted') => round2(months.reduce((x, m) => x + m[k], 0));
  return {
    as_of: asOf,
    horizon: { from: monthStart, to: horizonEnd },
    options: opts,
    summary: {
      billed_to_date: round2(taxable), billed_incl_gst: round2(total),
      collected: round2(payments.reduce((x, p) => x + p.amount, 0)),
      outstanding: round2(rev.filter((i) => i.status === 'sent' || i.status === 'partially_paid').reduce((x, i) => x + i.balance, 0)),
      recurring_customers: customers.length, mrr: round2(arr / 12), arr, top2_share: Math.round(top2 * 1000) / 10,
      one_off_total: round2(oneOff.reduce((x, o) => x + o.amount, 0)), gst_factor: gstFactor,
    },
    scenarios: { contracted: sumOf('contracted'), conservative: sumOf('conservative'), base: sumOf('base'), upside: sumOf('upside') },
    months, history, customers, one_off: oneOff.sort((a, b) => b.amount - a.amount), pipeline: { quotes: pipeline, total: pipelineTotal },
  };
}


export function optionsFrom(q: Record<string, unknown>): ProjOptions {
  return {
    churn_pct: num(q.churn, DEFAULT_OPTIONS.churn_pct, 0, 100),
    growth: num(q.growth, DEFAULT_OPTIONS.growth, 0, 10_000_000),
    growth_up: num(q.growth_up, DEFAULT_OPTIONS.growth_up, 0, 10_000_000),
  };
}


// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Growth / hiring plan — derived from the projection, so it moves whenever the projection moves.
//
// Idea: a hire is affordable when the team's loaded cost stays under `cap`% of monthly recurring revenue
// (the rest pays for infrastructure, tools, founders and profit). So each role has an "unlock MRR" =
// (existing costs + loaded cost of every higher-priority role + this one) / cap. The plan hires a role in the
// first projected month where MRR has reached its unlock level AND its operational trigger holds
// (e.g. enough customers to need a dedicated support person). Costs are ASSUMPTIONS (editable) — the
// books have no payroll data — and the plan says so.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface RoleDef {
  key: string; title: string; why: string; expertise: string[]; monthly: number; priority: number;
  min_customers: number; min_outstanding: number; trigger_text: string; note?: string;
}
export const ROLE_CATALOG: RoleDef[] = [
  { key: 'accounts', title: 'Accounts & Collections (part-time)', priority: 1, monthly: 15000, min_customers: 0, min_outstanding: 100000,
    why: 'Unpaid invoices are the fastest source of cash you already earned. Someone owns follow-ups, reconciliation and GST filing so the founders do not.',
    expertise: ['Tally / Zoho Books', 'GST returns (GSTR-1, 3B)', 'Collections follow-up', 'Bank & payment reconciliation'],
    trigger_text: 'Unpaid invoices of ₹1,00,000 or more', note: 'A freelance or part-time accountant is enough at this size.' },
  { key: 'cs', title: 'Customer Success & Support Executive', priority: 2, monthly: 30000, min_customers: 14, min_outstanding: 0,
    why: 'Recurring revenue only holds if customers are onboarded well and renew. One person can look after roughly 15–25 small accounts; your two biggest customers alone are over half of revenue.',
    expertise: ['SaaS onboarding & training', 'Customer communication (Hindi / English)', 'Field-force / CRM product knowledge', 'Ticket handling & renewals'],
    trigger_text: '14 or more recurring customers' },
  { key: 'sales', title: 'Inside Sales / Business Development Executive', priority: 3, monthly: 30000, min_customers: 0, min_outstanding: 0,
    why: 'Growth currently depends on the founders selling. A dedicated seller runs demos and follow-ups so new MRR no longer stalls when founders are busy.',
    expertise: ['B2B SaaS selling to SMBs', 'Product demos', 'CRM / field-force domain knowledge', 'Pipeline follow-up'],
    trigger_text: 'Revenue can fund the role', note: 'Add a commission (about 5–8% of first-year contract value) — not included in the budget.' },
  { key: 'dev', title: 'Full-stack / Mobile Developer', priority: 4, monthly: 75000, min_customers: 20, min_outstanding: 0,
    why: 'More customers means more feature requests and custom work. A second engineer ships faster and removes the single point of failure across web, iOS, Android and AWS.',
    expertise: ['TypeScript, Node.js, Next.js', 'React Native or Swift / Kotlin', 'PostgreSQL', 'AWS (ECS, RDS)'],
    trigger_text: '20 or more recurring customers' },
  { key: 'marketing', title: 'Growth & Digital Marketing Executive', priority: 5, monthly: 35000, min_customers: 25, min_outstanding: 0,
    why: 'Once sales can close what arrives, a steady inbound flow lowers the cost of each new customer.',
    expertise: ['SEO & content', 'LinkedIn / Meta ads', 'Lead-gen funnels', 'Analytics'],
    trigger_text: '25 or more recurring customers' },
  { key: 'senior', title: 'Senior Engineer / Tech Lead (DevOps, QA, Security)', priority: 6, monthly: 140000, min_customers: 40, min_outstanding: 0,
    why: 'At this scale reliability, security reviews and release quality need an owner.',
    expertise: ['System design', 'DevOps & monitoring', 'Test automation', 'Security / compliance'],
    trigger_text: '40 or more recurring customers' },
];

export interface GrowthOptions { cap_pct: number; oncost_pct: number; existing: number; costs: Record<string, number> }
export const DEFAULT_GROWTH: GrowthOptions = { cap_pct: 50, oncost_pct: 12, existing: 0, costs: {} };

type ScenarioKey = 'conservative' | 'base' | 'upside';

export function growthOptionsFrom(q: Record<string, unknown>): GrowthOptions {
  const costs: Record<string, number> = {};
  for (const r of ROLE_CATALOG) { const v = Number(q[`cost_${r.key}`]); if (Number.isFinite(v) && v >= 0 && q[`cost_${r.key}`] !== '' && q[`cost_${r.key}`] !== undefined) costs[r.key] = Math.min(v, 10_000_000); }
  return {
    cap_pct: num(q.cap, DEFAULT_GROWTH.cap_pct, 10, 100),
    oncost_pct: num(q.oncost, DEFAULT_GROWTH.oncost_pct, 0, 60),
    existing: num(q.existing, DEFAULT_GROWTH.existing, 0, 100_000_000),
    costs,
  };
}

export function buildGrowthPlan(proj: ReturnType<typeof buildProjection>, g: GrowthOptions) {
  const cap = g.cap_pct / 100;
  const customersNow = proj.summary.recurring_customers;
  const mrr0 = proj.summary.mrr;
  const avgMrr = customersNow > 0 ? mrr0 / customersNow : 0;
  const churn = Math.min(100, Math.max(0, proj.options.churn_pct)) / 100;
  const roles = ROLE_CATALOG.map((r) => {
    const monthly = g.costs[r.key] ?? r.monthly;
    return { ...r, monthly, loaded: round2(monthly * (1 + g.oncost_pct / 100)), one_time: monthly };
  });

  // Unlock MRR assumes every higher-priority role is already on the payroll.
  let cum = 0;
  const unlock = new Map<string, number>();
  for (const r of roles) { cum += r.loaded; unlock.set(r.key, round2((g.existing + cum) / cap)); }

  const plans = {} as Record<ScenarioKey, unknown>;
  for (const sc of ['conservative', 'base', 'upside'] as ScenarioKey[]) {
    const mrrAt = (k: number) => (sc === 'conservative' ? mrr0 * (1 - churn) : mrr0 + (sc === 'base' ? proj.options.growth : proj.options.growth_up) * (k + 1));
    const custAt = (k: number) => {
      if (sc === 'conservative') return Math.floor(customersNow * (1 - churn));
      const perMonth = avgMrr > 0 ? (sc === 'base' ? proj.options.growth : proj.options.growth_up) / avgMrr : 0;
      return Math.floor(customersNow + perMonth * (k + 1));
    };
    const hiredAt = new Map<string, number>();
    let payroll = 0;
    for (let k = 0; k < 12; k++) {
      for (const r of roles) {
        if (hiredAt.has(r.key)) continue;
        const trigger = custAt(k) >= r.min_customers && proj.summary.outstanding >= r.min_outstanding;
        const afford = mrrAt(k) >= (g.existing + payroll + r.loaded) / cap;
        if (trigger && afford) { hiredAt.set(r.key, k); payroll += r.loaded; }
      }
    }
    const out = roles.map((r) => {
      const k = hiredAt.get(r.key);
      const need = unlock.get(r.key) as number;
      let blocker: string | null = null;
      if (k === undefined) {
        const kk = 11;
        if (custAt(kk) < r.min_customers) blocker = `Needs ${r.min_customers} customers (projected ${custAt(kk)} by the end of the year)`;
        else if (r.min_outstanding && proj.summary.outstanding < r.min_outstanding) blocker = 'Unpaid invoices are below the trigger level';
        else blocker = `Needs monthly recurring revenue of ₹${Math.round(need).toLocaleString('en-IN')} (projected ₹${Math.round(mrrAt(kk)).toLocaleString('en-IN')} by the end of the year)`;
      }
      const gap = Math.max(0, need - mrr0);
      return {
        key: r.key, title: r.title, why: r.why, expertise: r.expertise, trigger: r.trigger_text, note: r.note ?? null, priority: r.priority,
        monthly_salary: r.monthly, monthly_loaded: r.loaded, one_time: r.one_time,
        unlock_mrr: need, unlock_alone: round2((g.existing + r.loaded) / cap), gap_mrr: round2(gap), more_customers: avgMrr > 0 ? Math.ceil(gap / avgMrr) : null,
        hire_month: k === undefined ? null : proj.months[k].month, hire_label: k === undefined ? null : proj.months[k].label,
        status: k === undefined ? 'beyond' : k === 0 ? 'now' : 'planned',
        year1_cost: k === undefined ? 0 : round2(r.loaded * (12 - k) + r.one_time), blocker,
      };
    });
    let payrollK = 0, cumNet = 0, peak = 0, oneTimeTotal = 0, payrollTotal = 0;
    const timeline = proj.months.map((m, k) => {
      const starting = roles.filter((r) => hiredAt.get(r.key) === k);
      const oneTime = starting.reduce((x, r) => x + r.one_time, 0);
      payrollK += starting.reduce((x, r) => x + r.loaded, 0);
      const billings = m[sc === 'conservative' ? 'conservative' : sc === 'base' ? 'base' : 'upside'];
      const net = round2(billings - payrollK - oneTime - g.existing);
      cumNet += net; peak = Math.max(peak, payrollK); oneTimeTotal += oneTime; payrollTotal += payrollK;
      return {
        month: m.month, label: m.label, mrr: round2(mrrAt(k)), customers: custAt(k), billings, payroll: round2(payrollK), one_time: round2(oneTime),
        existing: g.existing, net, cum_net: round2(cumNet), hires: starting.map((r) => r.title),
        payroll_pct: mrrAt(k) > 0 ? Math.round(((payrollK + g.existing) / mrrAt(k)) * 1000) / 10 : 0,
      };
    });
    const hires = out.filter((r) => r.status !== 'beyond').sort((a, b) => (a.hire_month as string).localeCompare(b.hire_month as string));
    const next = out.filter((r) => r.status === 'beyond').sort((a, b) => a.priority - b.priority)[0] ?? null;
    plans[sc] = {
      roles: out, timeline,
      budget: { year1_total: round2(payrollTotal + oneTimeTotal), payroll: round2(payrollTotal), one_time: round2(oneTimeTotal), peak_monthly: round2(peak), end_net: round2(cumNet) },
      headline: {
        hires: hires.length,
        first_hire: hires[0] ? { title: hires[0].title, month: hires[0].hire_month, label: hires[0].hire_label, status: hires[0].status } : null,
        next_unlock: next ? { title: next.title, unlock_mrr: next.unlock_mrr, gap_mrr: next.gap_mrr, more_customers: next.more_customers } : null,
      },
    };
  }
  return {
    options: g, current: { mrr: mrr0, customers: customersNow, avg_mrr_per_customer: round2(avgMrr), outstanding: proj.summary.outstanding },
    assumptions: [
      'Salaries are typical market estimates for a small SaaS team in Gurugram — your books hold no payroll data. Edit them below.',
      `Employer cost on top of salary: ${g.oncost_pct}% (PF, insurance, equipment). One-time cost per hire: one month's salary (recruiting + setup).`,
      `Team cost is kept under ${g.cap_pct}% of monthly recurring revenue; the rest covers infrastructure, tools, founders and profit.`,
      'Sales commission, founders\' pay and AWS / software costs are not included unless you enter them under "existing monthly costs".',
    ],
    plans,
  };
}

export async function projection(s: FinanceScope, query: Record<string, unknown>) {
  const asOf = new Date().toISOString().slice(0, 10);
  const err = (e: { message: string }) => new AppError(500, e.message, 'DB_ERROR');

  const docs = await fetchAll((a, b) => scoped(db().from('finance_documents').select(
    'id,customer_id,customer_snapshot,issue_date,status,taxable_value,total,balance,recurrence_enabled,recurrence_interval,recurrence_custom_every,recurrence_custom_unit'), s)
    .eq('doc_type', 'invoice').in('status', REVENUE_STATUSES).is('deleted_at', null).order('issue_date', { ascending: true }).range(a, b));

  // Longest billing duration on each invoice's lines (null when no line has one).
  const maxDur = new Map<string, number>();
  const ids = docs.map((d) => String(d.id));
  for (let i = 0; i < ids.length; i += 200) {
    const r = await db().from('finance_document_items').select('document_id,duration_months').in('document_id', ids.slice(i, i + 200)).not('duration_months', 'is', null);
    if (r.error) throw err(r.error);
    for (const row of r.data ?? []) maxDur.set(String(row.document_id), Math.max(maxDur.get(String(row.document_id)) ?? 0, Number(row.duration_months)));
  }

  const pays = await fetchAll((a, b) => scoped(db().from('finance_payments').select('payment_date,amount'), s).is('deleted_at', null).range(a, b));
  const qs = await fetchAll((a, b) => scoped(db().from('finance_documents').select('number,customer_id,customer_snapshot,taxable_value'), s)
    .eq('doc_type', 'quote').eq('status', 'sent').is('deleted_at', null).range(a, b));

  const name = (snap: unknown) => (snap as { name?: string } | null)?.name ?? '—';
  const invoices: ProjInvoice[] = docs.map((d) => ({
    customer_id: String(d.customer_id), customer: name(d.customer_snapshot), issue_date: String(d.issue_date).slice(0, 10),
    taxable: Number(d.taxable_value), total: Number(d.total), balance: Number(d.balance), status: String(d.status),
    recurrence_enabled: !!d.recurrence_enabled, recurrence_interval: (d.recurrence_interval as string | null) ?? null,
    recurrence_custom_every: (d.recurrence_custom_every as number | null) ?? null, recurrence_custom_unit: (d.recurrence_custom_unit as string | null) ?? null,
    max_duration_months: maxDur.get(String(d.id)) ?? null,
  }));
  const quotes: ProjQuote[] = qs.map((q) => ({ number: String(q.number), customer_id: String(q.customer_id), customer: name(q.customer_snapshot), taxable: Number(q.taxable_value) }));
  const payments: ProjPayment[] = pays.map((p) => ({ payment_date: String(p.payment_date).slice(0, 10), amount: Number(p.amount) }));
  const proj = buildProjection(invoices, quotes, payments, asOf, optionsFrom(query));
  return { ...proj, growth: buildGrowthPlan(proj, growthOptionsFrom(query)) };
}
