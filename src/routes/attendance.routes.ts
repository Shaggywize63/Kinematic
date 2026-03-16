import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../lib/supabase';

const router = Router();
const ORG_ID = '00000000-0000-0000-0000-000000000001';

// GET /api/v1/attendance/team
router.get('/team', requireAuth, async (req: Request, res: Response) => {
  try {
    const { date, city, zone_id } = req.query;
    const targetDate = (date as string) || new Date().toISOString().split('T')[0];

    let query = supabaseAdmin
      .from('attendance')
      .select(`
        id, date, status, checkin_at, checkout_at, total_hours, working_minutes,
        checkin_lat, checkin_lng, checkin_address, checkin_distance_m,
        user:user_id (id, name, mobile, employee_id, role, zone_id,
          zone:zone_id (id, name, city)
        )
      `)
      .eq('org_id', ORG_ID)
      .eq('date', targetDate)
      .order('checkin_at', { ascending: false });

    const { data, error } = await query;
    if (error) throw error;

    // Filter by city if provided
    let filtered = data || [];
    if (city) {
      filtered = filtered.filter((a: any) => 
        a.user?.zone?.city?.toLowerCase() === (city as string).toLowerCase()
      );
    }
    if (zone_id) {
      filtered = filtered.filter((a: any) => a.user?.zone_id === zone_id);
    }

    return res.json({ success: true, data: filtered });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/attendance/history
router.get('/history', requireAuth, async (req: Request, res: Response) => {
  try {
    const { user_id, from, to, page = '1', limit = '20' } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    let query = supabaseAdmin
      .from('attendance')
      .select(`
        id, date, status, checkin_at, checkout_at, total_hours, working_minutes, is_regularised,
        user:user_id (id, name, employee_id)
      `, { count: 'exact' })
      .eq('org_id', ORG_ID)
      .order('date', { ascending: false })
      .range(offset, offset + parseInt(limit as string) - 1);

    if (user_id) query = query.eq('user_id', user_id as string);
    if (from) query = query.gte('date', from as string);
    if (to) query = query.lte('date', to as string);

    const { data, error, count } = await query;
    if (error) throw error;

    return res.json({ success: true, data, total: count, page: parseInt(page as string), limit: parseInt(limit as string) });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/attendance/summary  
router.get('/summary', requireAuth, async (req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const { data: todayData, error } = await supabaseAdmin
      .from('attendance')
      .select('status')
      .eq('org_id', ORG_ID)
      .eq('date', today);

    if (error) throw error;

    const summary = {
      total: todayData?.length || 0,
      present: todayData?.filter((a: any) => a.status === 'present').length || 0,
      absent: todayData?.filter((a: any) => a.status === 'absent').length || 0,
      late: todayData?.filter((a: any) => a.status === 'late').length || 0,
      on_leave: todayData?.filter((a: any) => a.status === 'leave').length || 0,
    };

    return res.json({ success: true, data: summary });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/v1/attendance/:id/override
router.patch('/:id/override', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, override_reason } = req.body;
    const userId = (req as any).user?.id;

    const { data, error } = await supabaseAdmin
      .from('attendance')
      .update({ status, override_reason, override_by: userId, is_regularised: true, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('org_id', ORG_ID)
      .select()
      .single();

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
