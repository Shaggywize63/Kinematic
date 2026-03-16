import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';  // Add .js if NodeNext
import { AuthRequest } from '../types.js';           // Add .js if NodeNext
import { ok, badRequest } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';

interface UserWithName { name: string; }
interface ZoneWithDetails { name: string; city: string | null; meeting_lat?: number; meeting_lng?: number; }
interface AttendanceRecord {
  id: string;
  user_id: string;
  checkin_at?: string | null;
  checkout_at?: string | null;
  checkin_lat?: number | null;
  checkin_lng?: number | null;
  checkin_address?: string | null;
  total_hours?: number | null;
  working_minutes?: number | null;
  break_minutes?: number | null;
  status?: string;
  is_regularised?: boolean;
}
interface ExecWithZone { id: string; name: string; employee_id: string; zone_id?: string; zones?: ZoneWithDetails | null; }

const toIST = (utcDate: string | Date): Date => new Date(new Date(utcDate).getTime() + 5.5 * 60 * 60 * 1000);
const isoDate = (d: Date) => d.toISOString().split('T')[0];

// ... (getSummary, getActivityFeed, getHourly unchanged, as they use safe fallbacks)

// Fixed getLiveLocations
export const getLiveLocations = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const today = isoDate(new Date());

  const {  execs, error: execErr } = await supabaseAdmin
    .from('users').select('id, name, employee_id, zone_id, zones(name, city, meeting_lat, meeting_lng)')
    .eq('org_id', user.org_id).eq('role', 'executive').eq('is_active', true) as {  ExecWithZone[]; error: any };

  if (execErr) return badRequest(res, execErr.message);

  const {  att } = await supabaseAdmin
    .from('attendance').select('*')
    .eq('org_id', user.org_id).eq('date', today) as {  AttendanceRecord[] };

  const attMap = new Map(att?.map((a: AttendanceRecord) => [a.user_id, a]) || []);

  const locations = execs.map((fe: ExecWithZone) => {
    const rec = attMap.get(fe.id) as AttendanceRecord | undefined;
    const zone = fe.zones;
    const lat = rec?.checkin_lat ?? zone?.meeting_lat ?? null;
    const lng = rec?.checkin_lng ?? zone?.meeting_lng ?? null;
    const status = rec?.checkout_at ? 'checked_out' : rec ? 'active' : 'absent';
    return {
      id: fe.id, name: fe.name, employee_id: fe.employee_id,
      zone_name: zone?.name ?? null, city: zone?.city ?? null,
      status,
      checkin_at: rec?.checkin_at ?? null,
      checkout_at: rec?.checkout_at ?? null,
      lat, lng,
      address: rec?.checkin_address ?? null,
      total_hours: rec?.total_hours ?? null,
      is_regularised: !!rec?.is_regularised,
    };
  });

  const active = locations.filter((l) => l.status === 'active').length;
  const out = locations.filter((l) => l.status === 'checked_out').length;
  const absent = locations.filter((l) => l.status === 'absent').length;

  return ok(res, { date: today, summary: { total: locations.length, active, checked_out: out, absent }, locations });
});

// Fixed getAttendanceToday (similar pattern)
export const getAttendanceToday = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const today = isoDate(new Date());

  const {  execs, error: execErr } = await supabaseAdmin
    .from('users').select('id, name, employee_id, zone_id, zones(name)')
    .eq('org_id', user.org_id).eq('role', 'executive').eq('is_active', true) as {  ExecWithZone[]; error: any };

  if (execErr) return badRequest(res, execErr.message);

  const {  att } = await supabaseAdmin.from('attendance').select('*').eq('org_id', user.org_id).eq('date', today) as {  AttendanceRecord[] };
  // ... rest with type-safe access using ?? null and !! for booleans
  // (Apply similar typing to other functions)
});
