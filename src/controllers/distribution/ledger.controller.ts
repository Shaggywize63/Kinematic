import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, badRequest, isDemo } from '../../utils';
import { getDemoLedger, getDemoAgeingSummary } from '../../utils/demoDistribution';

// GET /api/v1/distribution/ledger
export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoLedger());

  let q = supabaseAdmin.from('ledger_entries').select('*')
    .eq('org_id', user.org_id).order('posted_at', { ascending: false }).limit(500);
  if (req.query.outlet_id)      q = q.eq('outlet_id', req.query.outlet_id as string);
  if (req.query.distributor_id) q = q.eq('distributor_id', req.query.distributor_id as string);
  const { data, error } = await q;
  if (error) return badRequest(res, error.message);
  ok(res, { entries: data });
});

// GET /api/v1/distribution/ledger/ageing
export const ageing = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getDemoAgeingSummary());

  // Pull all open invoices + their applied payments for the org.
  let q = supabaseAdmin.from('invoices').select('id, outlet_id, distributor_id, grand_total, issued_at, status')
    .eq('org_id', user.org_id).eq('status', 'issued');
  if (req.query.distributor_id) q = q.eq('distributor_id', req.query.distributor_id as string);
  const { data: invoices, error } = await q;
  if (error) return badRequest(res, error.message);

  // Naive: bucket each invoice by age. M2 ships this; a per-month snapshot
  // table would speed it up at scale (M3+).
  const now = Date.now();
  const buckets = { '0_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0 };
  for (const inv of (invoices || [])) {
    const days = Math.floor((now - new Date(inv.issued_at).getTime()) / 86400000);
    const total = Number(inv.grand_total);
    if (days <= 30)      buckets['0_30']    += total;
    else if (days <= 60) buckets['31_60']   += total;
    else if (days <= 90) buckets['61_90']   += total;
    else                 buckets['90_plus'] += total;
  }
  const total = Object.values(buckets).reduce((s, v) => s + v, 0);
  ok(res, { total_outstanding: total, buckets });
});
