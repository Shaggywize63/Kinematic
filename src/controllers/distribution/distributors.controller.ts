import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound, isDemo } from '../../utils';
import { audit } from '../../utils/audit';
import { getDemoDistributors, getDemoLedger } from '../../utils/demoDistribution';

const distributorSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1).max(32),
  legal_name: z.string().optional(),
  gstin: z.string().regex(/^[0-9A-Z]{15}$/).optional(),
  pan: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/).optional(),
  state_code: z.string().regex(/^\d{2}$/).optional(),
  place_of_supply: z.string().optional(),
  address: z.record(z.any()).optional(),
  contact_name: z.string().optional(),
  contact_mobile: z.string().optional(),
  email: z.string().email().optional(),
  credit_limit: z.number().nonnegative().optional(),
  payment_terms_days: z.number().int().nonnegative().optional(),
  customer_class: z.enum(['super_stockist', 'distributor', 'wholesaler']).optional(),
  assigned_brands: z.array(z.string().uuid()).optional(),
  region: z.string().optional(),
  city_id: z.string().uuid().optional(),
  is_active: z.boolean().optional(),
});

export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoDistributors());
  const q = req.query.q as string | undefined;
  const isActive = req.query.is_active as string | undefined;
  let qb = supabaseAdmin.from('distributors').select('*').eq('org_id', user.org_id).order('name');
  if (q) qb = qb.ilike('name', `%${q}%`);
  if (isActive === 'true') qb = qb.eq('is_active', true);
  if (isActive === 'false') qb = qb.eq('is_active', false);
  const { data, error } = await qb;
  if (error) return badRequest(res, error.message);
  ok(res, data);
});

export const get = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoDistributors()[0]);
  const { data, error } = await supabaseAdmin.from('distributors').select('*')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (error) return badRequest(res, error.message);
  if (!data) return notFound(res, 'Distributor not found');
  ok(res, data);
});

export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return created(res, { id: 'demo-new-dist', ...req.body });
  const parsed = distributorSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  const { data, error } = await supabaseAdmin.from('distributors').insert({
    ...parsed.data,
    org_id: user.org_id,
    client_id: user.client_id ?? null,
    created_by: user.id,
  }).select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'distributor.create', 'distributors', data.id, null, data);
  created(res, data, 'Distributor created');
});

export const update = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: req.params.id, ...req.body });
  const parsed = distributorSchema.partial().safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  const { data: before } = await supabaseAdmin.from('distributors').select('*')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Distributor not found');
  const { data, error } = await supabaseAdmin.from('distributors')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', user.org_id)
    .select().single();
  if (error) return badRequest(res, error.message);
  await audit(req, 'distributor.update', 'distributors', data.id, before, data);
  ok(res, data, 'Distributor updated');
});

export const remove = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: req.params.id });
  const { data: before } = await supabaseAdmin.from('distributors').select('*')
    .eq('id', req.params.id).eq('org_id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Distributor not found');
  const { error } = await supabaseAdmin.from('distributors')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('org_id', user.org_id);
  if (error) return badRequest(res, error.message);
  await audit(req, 'distributor.deactivate', 'distributors', req.params.id, before, { ...before, is_active: false });
  ok(res, { id: req.params.id, is_active: false }, 'Distributor deactivated');
});

// ── Receivables ageing (Wave D) ──────────────────────────────────────────────
// Real AR ageing: apply each distributor's cleared payments FIFO against its
// invoices oldest-first; the unpaid remainder of each invoice is aged by the
// invoice's issue date into 0-30 / 31-60 / 61-90 / 90+ buckets. Replaces the
// former zeros stub. Bounced/cancelled/failed payments do not reduce dues.
const DAY_MS = 86_400_000;
type Ageing = { '0_30': number; '31_60': number; '61_90': number; '90_plus': number };
const emptyAgeing = (): Ageing => ({ '0_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0 });
const DEAD_PAYMENT = new Set(['bounced', 'cancelled', 'failed', 'reversed']);

export type DistBilling = {
  distributor_id: string; invoiced_value: number; paid_value: number;
  outstanding: number; ageing: Ageing; oldest_due_days: number;
};

async function computeBilling(orgId: string, distributorId?: string): Promise<Map<string, DistBilling>> {
  let invQ = supabaseAdmin.from('invoices')
    .select('distributor_id, issued_at, grand_total')
    .eq('org_id', orgId).not('distributor_id', 'is', null).neq('status', 'cancelled').limit(10000);
  if (distributorId) invQ = invQ.eq('distributor_id', distributorId);
  let payQ = supabaseAdmin.from('payments')
    .select('distributor_id, amount, status, bounced_at')
    .eq('org_id', orgId).not('distributor_id', 'is', null).limit(10000);
  if (distributorId) payQ = payQ.eq('distributor_id', distributorId);
  const [{ data: invoices }, { data: payments }] = await Promise.all([invQ, payQ]);

  const invByDist = new Map<string, { issued_at: string; grand_total: number }[]>();
  for (const iv of (invoices as any[]) || []) {
    const arr = invByDist.get(iv.distributor_id) || [];
    arr.push({ issued_at: iv.issued_at, grand_total: Number(iv.grand_total) || 0 });
    invByDist.set(iv.distributor_id, arr);
  }
  const paidByDist = new Map<string, number>();
  for (const p of (payments as any[]) || []) {
    if (p.bounced_at || DEAD_PAYMENT.has((p.status || '').toLowerCase())) continue;
    paidByDist.set(p.distributor_id, (paidByDist.get(p.distributor_id) || 0) + (Number(p.amount) || 0));
  }

  const now = Date.now();
  const out = new Map<string, DistBilling>();
  const dists = new Set<string>([...invByDist.keys(), ...paidByDist.keys()]);
  for (const d of dists) {
    const invs = (invByDist.get(d) || []).sort((a, b) => (a.issued_at || '').localeCompare(b.issued_at || ''));
    let pool = paidByDist.get(d) || 0;
    const invoicedValue = invs.reduce((s, i) => s + i.grand_total, 0);
    const ageing = emptyAgeing();
    let outstanding = 0, oldestDue = 0;
    for (const iv of invs) {
      const applied = Math.min(pool, iv.grand_total);
      pool -= applied;
      const unpaid = iv.grand_total - applied;
      if (unpaid <= 0) continue;
      outstanding += unpaid;
      const ageDays = iv.issued_at ? Math.floor((now - new Date(iv.issued_at).getTime()) / DAY_MS) : 0;
      if (ageDays > oldestDue) oldestDue = ageDays;
      if (ageDays <= 30) ageing['0_30'] += unpaid;
      else if (ageDays <= 60) ageing['31_60'] += unpaid;
      else if (ageDays <= 90) ageing['61_90'] += unpaid;
      else ageing['90_plus'] += unpaid;
    }
    const round2 = (n: number) => Math.round(n * 100) / 100;
    out.set(d, {
      distributor_id: d, invoiced_value: round2(invoicedValue), paid_value: round2(paidByDist.get(d) || 0),
      outstanding: round2(outstanding),
      ageing: { '0_30': round2(ageing['0_30']), '31_60': round2(ageing['31_60']), '61_90': round2(ageing['61_90']), '90_plus': round2(ageing['90_plus']) },
      oldest_due_days: oldestDue,
    });
  }
  return out;
}

// ── Ledger / billing summary (per distributor) ───────────────────────────────
export const billingSummary = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { open_orders: 8, dispatched: 3, invoiced: 12, paid: 5, ageing: getDemoLedger().ageing });
  const distributorId = req.params.id;

  const { data: orders } = await supabaseAdmin
    .from('orders').select('status')
    .eq('org_id', user.org_id).eq('distributor_id', distributorId);
  const counts = (orders || []).reduce((acc: Record<string, number>, o: any) => {
    acc[o.status] = (acc[o.status] || 0) + 1;
    return acc;
  }, {});

  const billing = (await computeBilling(user.org_id, distributorId)).get(distributorId);
  const { data: distRow } = await supabaseAdmin.from('distributors')
    .select('credit_limit').eq('id', distributorId).eq('org_id', user.org_id).maybeSingle();
  const creditLimit = Number((distRow as any)?.credit_limit) || 0;
  const outstanding = billing?.outstanding || 0;

  ok(res, {
    open_orders: (counts.placed || 0) + (counts.approved || 0),
    invoiced: (counts.invoiced || 0) + (counts.partially_invoiced || 0),
    cancelled: counts.cancelled || 0,
    invoiced_value: billing?.invoiced_value || 0,
    paid_value: billing?.paid_value || 0,
    outstanding,
    credit_limit: creditLimit,
    credit_available: creditLimit > 0 ? Math.round((creditLimit - outstanding) * 100) / 100 : null,
    credit_utilization_pct: creditLimit > 0 ? Math.round((outstanding / creditLimit) * 1000) / 10 : null,
    oldest_due_days: billing?.oldest_due_days || 0,
    ageing: billing?.ageing || emptyAgeing(),
  });
});

// ── GET /distribution/distributors/ageing — portfolio receivables ────────────
export const ageingPortfolio = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { rows: [], summary: { outstanding: 0, ageing: emptyAgeing(), over_limit: 0 } });

  const billing = await computeBilling(user.org_id);
  const { data: dists } = await supabaseAdmin.from('distributors')
    .select('id, name, code, credit_limit, payment_terms_days, region').eq('org_id', user.org_id).limit(5000);

  const rows = ((dists as any[]) || []).map((d) => {
    const b = billing.get(d.id);
    const outstanding = b?.outstanding || 0;
    const creditLimit = Number(d.credit_limit) || 0;
    return {
      distributor_id: d.id, distributor_name: d.name, code: d.code || null, region: d.region || null,
      credit_limit: creditLimit, payment_terms_days: d.payment_terms_days ?? null,
      invoiced_value: b?.invoiced_value || 0, paid_value: b?.paid_value || 0,
      outstanding, ageing: b?.ageing || emptyAgeing(), oldest_due_days: b?.oldest_due_days || 0,
      credit_utilization_pct: creditLimit > 0 ? Math.round((outstanding / creditLimit) * 1000) / 10 : null,
      over_limit: creditLimit > 0 && outstanding > creditLimit,
    };
  }).filter((r) => r.outstanding > 0 || r.invoiced_value > 0)
    .sort((a, b) => b.outstanding - a.outstanding);

  const summary = rows.reduce((acc, r) => {
    acc.outstanding += r.outstanding;
    acc.ageing['0_30'] += r.ageing['0_30']; acc.ageing['31_60'] += r.ageing['31_60'];
    acc.ageing['61_90'] += r.ageing['61_90']; acc.ageing['90_plus'] += r.ageing['90_plus'];
    if (r.over_limit) acc.over_limit += 1;
    return acc;
  }, { outstanding: 0, ageing: emptyAgeing(), over_limit: 0 });
  summary.outstanding = Math.round(summary.outstanding * 100) / 100;

  ok(res, { rows, summary });
});
