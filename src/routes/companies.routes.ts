import { Router, Response } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { buildCompanyReport } from '../services/companyReport';
import { visibleCompanyIds, canSeeAll } from '../lib/companyVisibility';

const router = Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /companies/mine — the companies the caller may sell for, plus the active one.
// With no assigned companies this is just the user's own client (or empty), so the
// app can skip the picker.
router.get('/mine', async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const ids = (user.company_client_ids && user.company_client_ids.length > 0)
    ? user.company_client_ids
    : (user.client_id ? [user.client_id] : []);
  if (ids.length === 0) return res.json({ success: true, data: { companies: [], active: null } });
  const { data, error } = await supabaseAdmin.from('clients').select('id, name').in('id', ids).order('name');
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({
    success: true,
    data: {
      companies: data || [],
      active: user.client_id ?? null,
      // true only when there is a real choice to make
      pick_required: (user.company_client_ids?.length ?? 0) > 1,
    },
  });
});

// GET /companies/all — every company (client) in the caller's organisation, for the "who can sell for what" screen.
router.get('/all', requireRole('super_admin', 'admin', 'main_admin'), async (req: AuthRequest, res: Response) => {
  // A client-pinned admin only sees their own company, never the org's other clients.
  const visible = visibleCompanyIds(req.user);
  let q = supabaseAdmin.from('clients').select('id, name').eq('org_id', req.user!.org_id);
  if (visible) q = q.in('id', visible);
  const { data, error } = await q.order('name');
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data: data || [] });
});

// GET /companies/users/:userId — the companies this user may sell for (empty = just their own client).
router.get('/users/:userId', requireRole('super_admin', 'admin', 'main_admin'), async (req: AuthRequest, res: Response) => {
  const userId = String(req.params.userId);
  if (!UUID_RE.test(userId)) return res.status(400).json({ success: false, error: 'Invalid user id' });
  const orgId = req.user!.org_id;
  const visible = visibleCompanyIds(req.user);
  const u = await supabaseAdmin.from('users').select('id, client_id').eq('id', userId).eq('org_id', orgId).maybeSingle();
  // A user of another client looks exactly like a user that does not exist.
  if (!u.data || (visible && !canSeeAll(visible, u.data.client_id ? [u.data.client_id] : []))) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }
  const { data, error } = await supabaseAdmin.from('user_companies').select('client_id').eq('user_id', userId);
  if (error) return res.status(500).json({ success: false, error: error.message });
  // Only report the assignments the caller is allowed to know about.
  const ids = (data || []).map((r: { client_id: string }) => r.client_id).filter((c: string) => canSeeAll(visible, [c]));
  res.json({ success: true, data: { user_id: userId, client_ids: ids } });
});

// PUT /companies/users/:userId { client_ids: string[] } — replace a user's allowed
// companies. Admins only, and only within their own org.
router.put('/users/:userId', requireRole('super_admin', 'admin', 'main_admin'), async (req: AuthRequest, res: Response) => {
  const userId = String(req.params.userId);
  const clientIds: string[] = Array.isArray(req.body?.client_ids) ? req.body.client_ids.map(String) : [];
  if (!UUID_RE.test(userId) || clientIds.some((c) => !UUID_RE.test(c))) {
    return res.status(400).json({ success: false, error: 'Invalid user or company id' });
  }
  const orgId = req.user!.org_id;
  const visible = visibleCompanyIds(req.user);
  if (!canSeeAll(visible, clientIds)) {
    return res.status(403).json({ success: false, error: 'You can only assign your own companies' });
  }
  const [u, c] = await Promise.all([
    supabaseAdmin.from('users').select('id, client_id').eq('id', userId).eq('org_id', orgId).maybeSingle(),
    clientIds.length
      ? supabaseAdmin.from('clients').select('id').in('id', clientIds).eq('org_id', orgId)
      : Promise.resolve({ data: [] as { id: string }[], error: null }),
  ]);
  if (!u.data || (visible && !canSeeAll(visible, u.data.client_id ? [u.data.client_id] : []))) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }
  if ((c.data || []).length !== new Set(clientIds).size) {
    return res.status(400).json({ success: false, error: 'One or more companies are not in your organisation' });
  }
  // A scoped admin replaces only the assignments they can see; ones for other companies stay.
  let delQ = supabaseAdmin.from('user_companies').delete().eq('user_id', userId);
  if (visible) delQ = delQ.in('client_id', visible);
  const del = await delQ;
  if (del.error) return res.status(500).json({ success: false, error: del.error.message });
  if (clientIds.length) {
    const ins = await supabaseAdmin.from('user_companies').insert([...new Set(clientIds)].map((client_id) => ({ user_id: userId, client_id })));
    if (ins.error) return res.status(500).json({ success: false, error: ins.error.message });
  }
  res.json({ success: true, data: { user_id: userId, client_ids: [...new Set(clientIds)] } });
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAGE = 1000;

// Reads every row of a query, a page at a time (PostgREST caps a single response).
async function allRows<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// GET /companies/report?from=YYYY-MM-DD&to=YYYY-MM-DD — orders, invoices, collections and
// returns for each company in the caller's org, plus the all-company total. Admins only.
router.get('/report', requireRole('super_admin', 'admin', 'main_admin'), async (req: AuthRequest, res: Response) => {
  const orgId = req.user!.org_id;
  const today = new Date().toISOString().slice(0, 10);
  const from = String(req.query.from || today.slice(0, 8) + '01');
  const to = String(req.query.to || today);
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    return res.status(400).json({ success: false, error: 'from and to must be YYYY-MM-DD dates, from <= to' });
  }
  const start = `${from}T00:00:00.000Z`;
  const end = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86400000).toISOString();
  try {
    // Org-wide admins see every company; anyone tied to a client sees only theirs, and rows
    // with no company (which belong to nobody in particular) stay out of a scoped view.
    const visible = visibleCompanyIds(req.user);
    let cq = supabaseAdmin.from('clients').select('id, name').eq('org_id', orgId);
    if (visible) cq = cq.in('id', visible);
    const cos = await cq.order('name');
    if (cos.error) throw new Error(cos.error.message);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scoped = (q: any) => (visible ? q.in('client_id', visible) : q);
    const [orders, invoices, payments, returns] = await Promise.all([
      allRows((a, b) => scoped(supabaseAdmin.from('orders').select('client_id, grand_total').eq('org_id', orgId))
        .neq('status', 'cancelled').gte('placed_at', start).lt('placed_at', end).range(a, b)),
      allRows((a, b) => scoped(supabaseAdmin.from('invoices').select('client_id, grand_total').eq('org_id', orgId))
        .neq('status', 'cancelled').gte('issued_at', start).lt('issued_at', end).range(a, b)),
      allRows((a, b) => scoped(supabaseAdmin.from('payments').select('client_id, amount, mode').eq('org_id', orgId))
        .neq('status', 'bounced').gte('received_at', start).lt('received_at', end).range(a, b)),
      allRows((a, b) => scoped(supabaseAdmin.from('returns').select('client_id, total_value').eq('org_id', orgId))
        .not('status', 'in', '(rejected,cancelled)').gte('created_at', start).lt('created_at', end).range(a, b)),
    ]);
    const report = buildCompanyReport(cos.data || [], { orders, invoices, payments, returns } as any);
    res.json({ success: true, data: { from, to, ...report } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
