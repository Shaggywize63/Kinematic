import { Router, Response } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';

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

// PUT /companies/users/:userId { client_ids: string[] } — replace a user's allowed
// companies. Admins only, and only within their own org.
router.put('/users/:userId', requireRole('super_admin', 'admin', 'main_admin'), async (req: AuthRequest, res: Response) => {
  const userId = String(req.params.userId);
  const clientIds: string[] = Array.isArray(req.body?.client_ids) ? req.body.client_ids.map(String) : [];
  if (!UUID_RE.test(userId) || clientIds.some((c) => !UUID_RE.test(c))) {
    return res.status(400).json({ success: false, error: 'Invalid user or company id' });
  }
  const orgId = req.user!.org_id;
  const [u, c] = await Promise.all([
    supabaseAdmin.from('users').select('id').eq('id', userId).eq('org_id', orgId).maybeSingle(),
    clientIds.length
      ? supabaseAdmin.from('clients').select('id').in('id', clientIds).eq('org_id', orgId)
      : Promise.resolve({ data: [] as { id: string }[], error: null }),
  ]);
  if (!u.data) return res.status(404).json({ success: false, error: 'User not found' });
  if ((c.data || []).length !== new Set(clientIds).size) {
    return res.status(400).json({ success: false, error: 'One or more companies are not in your organisation' });
  }
  const del = await supabaseAdmin.from('user_companies').delete().eq('user_id', userId);
  if (del.error) return res.status(500).json({ success: false, error: del.error.message });
  if (clientIds.length) {
    const ins = await supabaseAdmin.from('user_companies').insert([...new Set(clientIds)].map((client_id) => ({ user_id: userId, client_id })));
    if (ins.error) return res.status(500).json({ success: false, error: ins.error.message });
  }
  res.json({ success: true, data: { user_id: userId, client_ids: [...new Set(clientIds)] } });
});

export default router;
