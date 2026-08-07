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
import * as leaveSvc from '../../../leave.service';
import type { Actor } from '../../../leave.service';
import * as attReg from '../../../attendanceRegularization.service';

function scopeToClient<Q>(q: Q, client_id: string | null): Q {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client_id ? ((q as any).eq('client_id', client_id) as Q) : q;
}

// Local UUID guard + string coercion — mirrors kiniTools.service (not exported
// there). Keeps a malformed id a clean tool error rather than a Postgres 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));

// Field-Force writes are manager/admin actions. The FF module is org-scoped
// (route_plans / route_plan_outlets have no client_id), so tenant isolation for
// these tools rides on org_id. Role vocabulary mirrors requireSupervisorOrAbove
// in middleware/auth.ts. Defensive default: an empty/unknown role is refused.
// (ff_approve_* additionally re-check approver/admin inside the shared service.)
const FF_MANAGER_ROLES = new Set(['super_admin', 'admin', 'main_admin', 'sub_admin', 'org_admin', 'client', 'city_manager', 'supervisor']);
function ffRoleGate(ctx: { role?: string | null } | undefined, human: string): { data: { error: string } } | null {
  const key = String(ctx?.role ?? '').toLowerCase().trim();
  if (FF_MANAGER_ROLES.has(key)) return null;
  return { data: { error: `This action requires a ${human} role — your role (${key || 'unknown'}) isn't permitted.` } };
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
  // ── Wave 3: Field-Force writes (confirm-gated) ────────────────────────────
  {
    name: 'ff_assign_visit',
    description:
      "Assign a store/outlet visit to a field executive by adding it to their day's route plan. Provide user_id (the FE) and store_id (the outlet); optionally plan_date (YYYY-MM-DD, defaults today) and activity_id (defaults to the org's first activity type). Creates the day's route plan if the FE has none yet, then appends the outlet. Requires a manager/admin role.",
    input_schema: { type: 'object', required: ['user_id', 'store_id'], properties: {
      user_id: { type: 'string', description: 'The field executive to assign the visit to.' },
      store_id: { type: 'string', description: 'The store/outlet to visit.' },
      plan_date: { type: 'string', description: 'YYYY-MM-DD; defaults to today.' },
      activity_id: { type: 'string', description: "Activity type for the plan; defaults to the org's first activity." },
    }},
    exec: async (org_id, _client_id, args, ctx) => {
      const denied = ffRoleGate(ctx, 'manager or admin');
      if (denied) return denied;
      const userId = str(args.user_id);
      const storeId = str(args.store_id);
      if (!isUuid(userId)) return { data: { error: 'A valid user_id (field executive) is required.' } };
      if (!isUuid(storeId)) return { data: { error: 'A valid store_id (outlet) is required.' } };
      if (args.activity_id !== undefined && args.activity_id !== null && args.activity_id !== '' && !isUuid(String(args.activity_id))) {
        return { data: { error: 'activity_id must be a valid id.' } };
      }
      // Verify FE + store live in this org (FF tables are org-scoped by org_id).
      const [{ data: fe }, { data: store }] = await Promise.all([
        supabaseAdmin.from('users').select('id, name').eq('id', userId).eq('org_id', org_id).maybeSingle(),
        supabaseAdmin.from('stores').select('id, name').eq('id', storeId).eq('org_id', org_id).maybeSingle(),
      ]);
      if (!fe) return { data: { error: 'That field executive was not found in this org.' } };
      if (!store) return { data: { error: 'That outlet was not found in this org.' } };
      const planDate = /^\d{4}-\d{2}-\d{2}$/.test(str(args.plan_date)) ? str(args.plan_date) : new Date().toISOString().slice(0, 10);
      // Resolve an activity_id — explicit, else the org's first activity type.
      let activityId = isUuid(args.activity_id) ? str(args.activity_id) : '';
      if (!activityId) {
        const { data: act } = await supabaseAdmin.from('activities').select('id').eq('org_id', org_id).limit(1).maybeSingle();
        if (!act) return { data: { error: 'No activity types configured for this org — pass an explicit activity_id.' } };
        activityId = act.id as string;
      }
      // Find-or-create the route plan for (org, user, date, activity).
      let planId = '';
      const { data: existingPlan } = await supabaseAdmin.from('route_plans').select('id')
        .eq('org_id', org_id).eq('user_id', userId).eq('plan_date', planDate).eq('activity_id', activityId).maybeSingle();
      if (existingPlan) {
        planId = existingPlan.id as string;
      } else {
        const { data: createdPlan, error: cErr } = await supabaseAdmin.from('route_plans').insert({
          org_id, user_id: userId, plan_date: planDate, activity_id: activityId,
          created_by: ctx?.user_id ?? null, total_outlets: 0, status: 'pending',
        }).select('id').single();
        if (cErr) return { data: { error: cErr.message } };
        planId = createdPlan.id as string;
      }
      // Don't assign the same outlet twice on one plan.
      const { data: dupe } = await supabaseAdmin.from('route_plan_outlets').select('id')
        .eq('route_plan_id', planId).eq('store_id', storeId).maybeSingle();
      if (dupe) return { data: { error: `${store.name || 'That outlet'} is already on the plan for ${planDate}.` } };
      // Append the outlet; visit_order = current count + 1.
      const { count } = await supabaseAdmin.from('route_plan_outlets')
        .select('id', { count: 'exact', head: true }).eq('route_plan_id', planId);
      const nextOrder = (count || 0) + 1;
      const { data: rpo, error: rErr } = await supabaseAdmin.from('route_plan_outlets').insert({
        route_plan_id: planId, store_id: storeId, org_id, visit_order: nextOrder,
        target_type: 'general', is_geofenced: true, geofence_radius_m: 100, status: 'pending',
      }).select('id').single();
      if (rErr) return { data: { error: rErr.message } };
      await supabaseAdmin.from('route_plans').update({ total_outlets: nextOrder }).eq('id', planId).eq('org_id', org_id);
      const message = `Assigned ${store.name || 'outlet'} to ${fe.name || 'the FE'} for ${planDate}.`;
      return {
        card: { type: 'summary', data: { text: message } },
        data: { route_plan_id: planId, route_plan_outlet_id: rpo.id, visit_order: nextOrder, plan_date: planDate, message },
      };
    },
  },
  {
    name: 'ff_approve_attendance',
    description:
      "Approve or reject a pending attendance-regularization request (a fix for a missed/wrong punch). Provide request_id and decision ('approved' or 'rejected'), plus an optional note. Only the request's approver or an admin may decide (enforced server-side); on approval the correction is written onto the attendance row.",
    input_schema: { type: 'object', required: ['request_id', 'decision'], properties: {
      request_id: { type: 'string' },
      decision: { type: 'string', enum: ['approved', 'rejected'] },
      note: { type: 'string' },
    }},
    exec: async (org_id, client_id, args, ctx) => {
      const requestId = str(args.request_id);
      if (!isUuid(requestId)) return { data: { error: 'A valid request_id is required.' } };
      const decision = args.decision === 'rejected' ? 'rejected' : args.decision === 'approved' ? 'approved' : '';
      if (!decision) return { data: { error: "decision must be 'approved' or 'rejected'." } };
      const actorId = str(ctx?.user_id);
      if (!isUuid(actorId)) return { data: { error: 'Cannot identify the current user, so the decision was not applied.' } };
      const actor: Actor = { id: actorId, org_id, role: ctx?.role ?? null, client_id: client_id ?? null };
      // Service re-checks approver/admin + pending state, throws on violation
      // (caught by the v2 dispatcher and surfaced as a tool error).
      const result = await attReg.decide(actor, requestId, decision as 'approved' | 'rejected', str(args.note) || undefined);
      const message = `Attendance request ${decision}.`;
      return { card: { type: 'summary', data: { text: message } }, data: { ...result, message } };
    },
  },
  {
    name: 'ff_approve_leave',
    description:
      "Approve or reject a pending leave request. Provide request_id and decision ('approved' or 'rejected'), plus an optional note. Only the request's approver or an admin may decide (enforced server-side); on approval the leave is booked against the applicant's balance.",
    input_schema: { type: 'object', required: ['request_id', 'decision'], properties: {
      request_id: { type: 'string' },
      decision: { type: 'string', enum: ['approved', 'rejected'] },
      note: { type: 'string' },
    }},
    exec: async (org_id, client_id, args, ctx) => {
      const requestId = str(args.request_id);
      if (!isUuid(requestId)) return { data: { error: 'A valid request_id is required.' } };
      const decision = args.decision === 'rejected' ? 'rejected' : args.decision === 'approved' ? 'approved' : '';
      if (!decision) return { data: { error: "decision must be 'approved' or 'rejected'." } };
      const actorId = str(ctx?.user_id);
      if (!isUuid(actorId)) return { data: { error: 'Cannot identify the current user, so the decision was not applied.' } };
      const actor: Actor = { id: actorId, org_id, role: ctx?.role ?? null, client_id: client_id ?? null };
      const result = await leaveSvc.decide(actor, requestId, decision as 'approved' | 'rejected', str(args.note) || undefined);
      const message = `Leave request ${decision}.`;
      return { card: { type: 'summary', data: { text: message } }, data: { ...result, message } };
    },
  },
];
