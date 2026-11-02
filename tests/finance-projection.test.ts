import { buildProjection, buildGrowthPlan, optionsFrom, growthOptionsFrom, DEFAULT_OPTIONS, DEFAULT_GROWTH, type ProjInvoice, type ProjQuote } from '../src/services/finance/projection.service';

const AS_OF = '2026-11-02';
let n = 0;
const inv = (customer: string, issue_date: string, taxable: number, o: Partial<ProjInvoice> = {}): ProjInvoice => ({
  customer_id: customer, customer, issue_date, taxable, total: Math.round(taxable * 1.18), balance: 0, status: 'paid', ...o, ...(n++ < 0 ? {} : {}),
});

// Shapes taken from a real book (names changed): quarterly + monthly customers without a repeat schedule,
// repeat-schedule customers, a duration-only customer, a one-off project and a void invoice.
const INVOICES: ProjInvoice[] = [
  inv('Alpha', '2026-07-02', 48750), inv('Alpha', '2026-10-02', 48750, { status: 'sent', balance: 57525 }),
  inv('Bravo', '2026-08-10', 15000), inv('Bravo', '2026-08-10', 4500), inv('Bravo', '2026-09-02', 15000), inv('Bravo', '2026-10-02', 15000),
  inv('Bravo', '2026-10-31', 15000, { status: 'sent', balance: 17700 }),
  inv('Charlie', '2026-09-24', 1800, { recurrence_enabled: true, recurrence_interval: 'monthly' }),
  inv('Charlie', '2026-10-31', 2800, { status: 'sent', balance: 3304, recurrence_enabled: true, recurrence_interval: 'monthly' }),
  inv('Delta', '2026-10-05', 24000, { recurrence_enabled: true, recurrence_interval: 'half_yearly', max_duration_months: 6 }),
  inv('Delta', '2026-10-26', 6000, { recurrence_enabled: true, recurrence_interval: 'half_yearly', max_duration_months: 6 }),
  inv('Echo', '2026-10-09', 19500, { recurrence_enabled: true, recurrence_interval: 'half_yearly' }),
  inv('Foxtrot', '2026-10-21', 6000, { recurrence_enabled: true, recurrence_interval: 'half_yearly' }),
  inv('Golf', '2026-10-22', 6000, { status: 'sent', balance: 7080, recurrence_enabled: true, recurrence_interval: 'quarterly' }),
  inv('Hotel', '2026-10-24', 15750, { status: 'sent', balance: 15750, max_duration_months: 6 }),
  inv('India', '2026-10-27', 9000, { status: 'sent', balance: 10620, recurrence_enabled: true, recurrence_interval: 'half_yearly' }),
  inv('Juliet', '2026-10-27', 6500, { status: 'sent', balance: 7670, recurrence_enabled: true, recurrence_interval: 'monthly' }),
  inv('Kilo', '2026-11-02', 2000, { status: 'sent', balance: 2360, recurrence_enabled: true, recurrence_interval: 'monthly' }),
  inv('Lima', '2026-06-25', 40000),                                   // one-off project
  inv('Mike', '2026-10-12', 2600, { status: 'void' }),                // void — never counted
  inv('November', '2026-10-01', 9999, { status: 'draft' }),           // draft — never counted
];
const QUOTES: ProjQuote[] = [
  { number: 'QT-1', customer_id: 'Oscar', customer: 'Oscar', taxable: 175000 },
  { number: 'QT-2', customer_id: 'Oscar', customer: 'Oscar', taxable: 175000 }, // same customer + amount → counted once
  { number: 'QT-3', customer_id: 'Papa', customer: 'Papa', taxable: 3200 },
];
const PAYMENTS = [{ payment_date: '2026-09-02', amount: 17700 }, { payment_date: '2026-10-08', amount: 12000 }, { payment_date: '2026-10-29', amount: 40000 }];

describe('billing projection', () => {
  const p = buildProjection(INVOICES, QUOTES, PAYMENTS, AS_OF);

  it('derives the annual recurring revenue per customer from schedule, line duration or invoice history', () => {
    const by = Object.fromEntries(p.customers.map((c) => [c.customer, c]));
    expect(by.Alpha).toMatchObject({ cadence: 'Quarterly', source: 'history', cycle_amount: 48750, per_year: 195000, next_billing: '2027-01-02' });
    expect(by.Bravo).toMatchObject({ cadence: 'Monthly', source: 'history', cycle_amount: 15000, per_year: 180000 });   // older months are not double counted
    expect(by.Charlie).toMatchObject({ source: 'schedule', cycle_amount: 2800, per_year: 33600 });
    expect(by.Delta).toMatchObject({ cadence: 'Half-yearly', cycle_amount: 30000, per_year: 60000, invoices_in_cycle: 2 }); // two invoices, one cycle
    expect(by.Hotel).toMatchObject({ cadence: 'Half-yearly', source: 'duration', per_year: 31500 });
    expect(p.summary.arr).toBe(695100);
    expect(p.summary.mrr).toBe(57925);
    expect(p.summary.recurring_customers).toBe(11);
  });

  it('keeps one-off, void and draft invoices out of the run-rate', () => {
    expect(p.customers.map((c) => c.customer)).not.toContain('Lima');
    expect(p.one_off).toEqual([{ customer: 'Lima', amount: 40000, date: '2026-06-25' }]);
    expect(p.summary.one_off_total).toBe(40000);
    expect(p.summary.billed_to_date).toBe(INVOICES.filter((i) => i.status !== 'void' && i.status !== 'draft').reduce((x, i) => x + i.taxable, 0));
  });

  it('schedules each customer’s next bills into the 12 months starting this month', () => {
    expect(p.months).toHaveLength(12);
    expect(p.months[0].month).toBe('2026-11');
    expect(p.months[11].month).toBe('2027-10');
    expect(p.months[0].contracted).toBe(24300);   // Bravo 15,000 + Juliet 6,500 + Charlie 2,800
    expect(p.months[1].contracted).toBe(26300);   // + Kilo 2,000 (its November bill went out today)
    expect(p.scenarios.contracted).toBe(693100);  // a year of renewals, minus Kilo's November bill already issued
  });

  it('builds conservative / base / upside scenarios and de-duplicates open quotes', () => {
    expect(p.pipeline.total).toBe(178200);
    expect(p.scenarios.conservative).toBe(Math.round(693100 * 0.85 * 100) / 100);
    expect(p.scenarios.base).toBe(693100 + 2500 * 78);
    expect(p.scenarios.upside).toBe(693100 + 5000 * 78 + 178200);
    expect(p.months[11].cum_base).toBe(p.scenarios.base);
  });

  it('reports history, outstanding and the GST factor', () => {
    expect(p.history[0]).toMatchObject({ month: '2026-06', billed: 40000, collected: 0 });
    expect(p.history.find((h) => h.month === '2026-10')?.collected).toBe(52000);
    expect(p.summary.outstanding).toBe(57525 + 17700 + 3304 + 7080 + 15750 + 10620 + 7670 + 2360);
    expect(p.summary.gst_factor).toBeGreaterThan(1.1);
    expect(p.summary.top2_share).toBe(53.9);
  });

  it('clamps scenario inputs', () => {
    expect(optionsFrom({ churn: '250', growth: '-5', growth_up: 'abc' })).toEqual({ churn_pct: 100, growth: 0, growth_up: DEFAULT_OPTIONS.growth_up });
  });
});

describe('growth / hiring plan', () => {
  const p = buildProjection(INVOICES, QUOTES, PAYMENTS, AS_OF);
  const g = buildGrowthPlan(p, DEFAULT_GROWTH);
  const role = (sc: 'conservative' | 'base' | 'upside', key: string) => (g.plans[sc] as { roles: Array<Record<string, unknown>> }).roles.find((r) => r.key === key) as Record<string, unknown>;

  it('computes the revenue each hire needs: loaded cost ÷ payroll cap, cumulative in priority order', () => {
    expect(role('base', 'accounts')).toMatchObject({ monthly_loaded: 16800, unlock_mrr: 33600, unlock_alone: 33600 });
    expect(role('base', 'cs')).toMatchObject({ monthly_loaded: 33600, unlock_mrr: 100800, unlock_alone: 67200 });
    expect(role('base', 'sales').unlock_mrr).toBe(168000);
  });

  it('hires the part-time accountant now (trigger + affordable) and waits on revenue for the rest', () => {
    expect(role('base', 'accounts')).toMatchObject({ status: 'now', hire_month: '2026-11' });
    expect(role('base', 'cs')).toMatchObject({ status: 'beyond', hire_month: null });
    expect(String(role('base', 'cs').blocker)).toMatch(/monthly recurring revenue/);
  });

  it('moves hires earlier when the projection is stronger and never hires in the conservative case beyond what revenue funds', () => {
    expect(role('upside', 'cs')).toMatchObject({ status: 'planned', hire_month: '2027-07' });
    expect(role('upside', 'sales').status).toBe('beyond');
    expect(role('conservative', 'cs').status).toBe('beyond');
    expect(role('conservative', 'accounts').status).toBe('now');
  });

  it('budgets payroll month by month with one-off hiring cost and net after payroll', () => {
    const base = g.plans.base as { timeline: Array<Record<string, number | string | string[]>>; budget: Record<string, number> };
    expect(base.timeline[0]).toMatchObject({ payroll: 16800, one_time: 15000 });
    expect(base.timeline[1]).toMatchObject({ payroll: 16800, one_time: 0 });
    expect(base.budget).toMatchObject({ payroll: 16800 * 12, one_time: 15000, year1_total: 16800 * 12 + 15000, peak_monthly: 16800 });
  });

  it('reacts to the inputs: a lower cap or higher existing costs delays hiring, edited salaries change the budget', () => {
    const strict = buildGrowthPlan(p, { ...DEFAULT_GROWTH, existing: 40000 });
    expect((strict.plans.base as { roles: Array<{ key: string; status: string }> }).roles.find((r) => r.key === 'accounts')?.status).toBe('beyond');
    const pricey = buildGrowthPlan(p, growthOptionsFrom({ cost_accounts: '20000', cap: '50' }));
    expect((pricey.plans.base as { budget: { year1_total: number } }).budget.year1_total).toBe(22400 * 12 + 20000);
  });
});
