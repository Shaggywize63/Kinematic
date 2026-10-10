/**
 * Day travel — DB-facing half (the computation is travel.service.ts, which takes these fetchers as
 * arguments so it needs no database in tests).
 *
 * Callers are responsible for tenant scoping: `userId` must already be a person the caller may see
 * (self, or a team member inside the caller's org / client / supervisor scope). `orgId`, when given,
 * additionally pins the GPS trail query to that org exactly like the expense mileage suggestion.
 */
import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';
import { AppError } from '../utils';
import {
  getDayTravel, type DayTravel, type RawVisitRow, type TrailRow, type TravelAttendanceRow, type TravelFetchers,
} from './travel.service';

const VISIT_LIMIT = 500;
const TRAIL_LIMIT = 10_000;

export function dbTravelFetchers(orgId?: string | null): TravelFetchers {
  return {
    async attendance(userId, date): Promise<TravelAttendanceRow | null> {
      const { data, error } = await supabaseAdmin
        .from('attendance')
        .select('id, status, checkin_at, checkout_at, checkin_lat, checkin_lng, checkout_lat, checkout_lng')
        .eq('user_id', userId)
        .eq('date', date)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw new AppError(500, error.message, 'DB_ERROR');
      return ((data as TravelAttendanceRow[] | null) ?? [])[0] ?? null;
    },

    async visits(userId, fromIso, toIso): Promise<RawVisitRow[]> {
      // Both submission tables. A failure of one is logged and treated as "no visits there": the
      // day's legs then simply span those visits, which can only err towards the straight/trail
      // distance — never fail the whole travel read.
      const read = async (source: 'form' | 'builder'): Promise<RawVisitRow[]> => {
        const table = source === 'form' ? 'form_submissions' : 'builder_submissions';
        const formFk = source === 'form' ? 'template_id' : 'form_id';
        const { data, error } = await supabaseAdmin
          .from(table)
          .select(`*, builder_forms:${formFk}(title)`)
          .eq('user_id', userId)
          .gte('check_in_at', fromIso)
          .lte('check_in_at', toIso)
          .not('check_out_at', 'is', null)
          .order('check_in_at', { ascending: true })
          .limit(VISIT_LIMIT);
        if (error) {
          logger.warn(`[travel] could not read ${table} for user=${userId}: ${error.message}`);
          return [];
        }
        return ((data as Array<Record<string, any>> | null) ?? []).map((row) => ({ source, row }));
      };
      const [forms, builder] = await Promise.all([read('form'), read('builder')]);
      return [...forms, ...builder];
    },

    async trail(userId, fromIso, toIso): Promise<TrailRow[]> {
      let q = supabaseAdmin
        .from('work_activity')
        .select('lat, lng, captured_at, is_mock, is_suspect')
        .eq('user_id', userId)
        .gte('captured_at', fromIso)
        .lte('captured_at', toIso)
        .not('lat', 'is', null)
        .not('lng', 'is', null);
      if (orgId) q = q.eq('org_id', orgId);
      const { data, error } = await q.order('captured_at', { ascending: true }).limit(TRAIL_LIMIT);
      if (error) throw new AppError(500, error.message, 'DB_ERROR');
      return (data as TrailRow[] | null) ?? [];
    },
  };
}

/** The user's travel on an IST day, from the database. */
export async function dayTravel(
  userId: string,
  date: string,
  opts: { orgId?: string | null; nowMs?: number } = {},
): Promise<DayTravel> {
  return getDayTravel(dbTravelFetchers(opts.orgId), { userId, date, nowMs: opts.nowMs });
}
