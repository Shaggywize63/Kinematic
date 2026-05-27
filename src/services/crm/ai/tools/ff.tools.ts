/**
 * Field Force tools exposed to KINI agentic v2.
 *
 * Proof-of-concept module showing the pattern for cross-module agentic
 * coverage. Each tool returns `{ data, card? }` matching the legacy
 * kiniTools.service.ts shape. Distribution / Analytics / Admin modules
 * follow the same pattern in subsequent PRs.
 */
import { supabaseAdmin } from '../../../../lib/supabase';
import type { KiniTool } from '../kiniTools.service';

function scopeToClient<Q>(q: Q, client_id: string | null): Q {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client_id ? ((q as any).eq('client_id', client_id) as Q) : q;
}

export const ffTools: KiniTool[] = [
  {
    name: 'ff_attendance_today',
    description:
      "Today's field attendance roll — who has checked in, who is on break, who is offline. Use for 'who is working today', 'attendance count for Pune', or to brief a manager on field presence.",
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'Optional city filter.' },
      },
    },
    exec: async (org_id, client_id, args) => {
      const today = new Date().toISOString().slice(0, 10);
      let q = supabaseAdmin
        .from('attendance')
        .select('user_id, status, check_in_at, check_out_at, city')
        .eq('org_id', org_id)
        .gte('check_in_at', `${today}T00:00:00Z`);
      q = scopeToClient(q, client_id);
      if (typeof args.city === 'string' && args.city) q = q.eq('city', args.city);
      const { data, error } = await q;
      if (error) return { data: { error: error.message } };
      const rows = (data || []) as Array<{ check_out_at: string | null }>;
      const summary = {
        total: rows.length,
        checked_in: rows.filter((r) => !r.check_out_at).length,
        checked_out: rows.filter((r) => r.check_out_at).length,
      };
      return {
        data: { summary, rows: rows.slice(0, 50) },
        card: { type: 'ff_attendance_summary', data: summary },
      };
    },
  },
  {
    name: 'ff_live_locations',
    description:
      "Latest known GPS location of every field executive currently active. Use for 'where is my team right now', 'who is closest to <city>', or live-map style questions. Includes battery and device info so you can flag low-battery executives.",
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        limit: { type: 'number', default: 50 },
      },
    },
    exec: async (org_id, client_id, args) => {
      const limit = Math.min(Number(args.limit) || 50, 200);
      let q = supabaseAdmin
        .from('user_status')
        .select('user_id, lat, lng, battery_level, device_model, updated_at, city')
        .eq('org_id', org_id)
        .order('updated_at', { ascending: false })
        .limit(limit);
      q = scopeToClient(q, client_id);
      if (typeof args.city === 'string' && args.city) q = q.eq('city', args.city);
      const { data, error } = await q;
      if (error) return { data: { error: error.message } };
      const rows = data || [];
      return {
        data: { count: rows.length, rows },
        card: { type: 'ff_live_locations', data: { count: rows.length } },
      };
    },
  },
  {
    name: 'ff_visits_today',
    description:
      "Store/outlet visits logged today. Useful for 'how many visits today', 'show Pune visits', or 'which executives haven't logged a visit yet'.",
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        user_id: { type: 'string', description: 'Filter to one executive.' },
        limit: { type: 'number', default: 50 },
      },
    },
    exec: async (org_id, client_id, args) => {
      const today = new Date().toISOString().slice(0, 10);
      let q = supabaseAdmin
        .from('visits')
        .select('id, user_id, outlet_id, city, status, started_at, ended_at')
        .eq('org_id', org_id)
        .gte('started_at', `${today}T00:00:00Z`)
        .order('started_at', { ascending: false })
        .limit(Math.min(Number(args.limit) || 50, 200));
      q = scopeToClient(q, client_id);
      if (typeof args.city === 'string' && args.city) q = q.eq('city', args.city);
      if (typeof args.user_id === 'string' && args.user_id) q = q.eq('user_id', args.user_id);
      const { data, error } = await q;
      if (error) return { data: { error: error.message } };
      const rows = data || [];
      return {
        data: { count: rows.length, rows },
        card: { type: 'ff_visits_today', data: { count: rows.length } },
      };
    },
  },
];
