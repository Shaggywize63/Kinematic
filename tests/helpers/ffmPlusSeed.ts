/**
 * Seed for the FFM analytics (plus) tests: one org with three reps, two supervisors, a handful of outlets,
 * plans / visits / orders / attendance around "today" = Tue 2026-11-10 (IST), plus a second org and a
 * few look-alike rows that must NEVER be counted (inactive rep, non-field user, cancelled / draft orders, the
 * other org, a plan beyond the window, a future plan).
 *
 * Every expected number in the tests is worked out by hand from THIS file — change a row here and the
 * arithmetic in the tests changes with it. Calendar facts used: 2026-11-09 is a Monday (ISO week 2026-W46),
 * 2026-11-02 the Monday before (W45); 2026-09-20 is 51 days before today.
 */
export const ORG = '00000000-0000-4000-8000-0000000000aa';
export const ORG_B = '00000000-0000-4000-8000-0000000000bb';
export const CLIENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const R1 = '10000000-0000-4000-8000-000000000001'; // Asha   - executive, supervisor S1
export const R2 = '10000000-0000-4000-8000-000000000002'; // Bala   - field_executive, supervisor S1
export const R3 = '10000000-0000-4000-8000-000000000003'; // Chitra - executive, supervisor S2
export const R4 = '10000000-0000-4000-8000-000000000004'; // Dev    - INACTIVE executive
export const S1 = '20000000-0000-4000-8000-000000000001'; // Meera  - supervisor
export const S2 = '20000000-0000-4000-8000-000000000002'; // Ravi   - supervisor
export const ADMIN = '30000000-0000-4000-8000-000000000001'; // not a field rep
export const XB = '40000000-0000-4000-8000-000000000001'; // a rep of the OTHER org

export const ST1 = '50000000-0000-4000-8000-000000000001';
export const ST2 = '50000000-0000-4000-8000-000000000002';
export const ST3 = '50000000-0000-4000-8000-000000000003';
export const ST4 = '50000000-0000-4000-8000-000000000004';
export const ST5 = '50000000-0000-4000-8000-000000000005';
export const STX = '50000000-0000-4000-8000-0000000000ff';

export const TODAY = '2026-11-10';
/** 06:00 UTC = 11:30 IST on TODAY. */
export const NOW = new Date('2026-11-10T06:00:00Z');

const user = (id: string, name: string, role: string, extra: Record<string, unknown> = {}) =>
  ({ id, org_id: ORG, name, role, is_active: true, deleted_at: null, client_id: null, supervisor_id: null, ...extra });

const plan = (id: string, user_id: string, plan_date: string, label: string, total: number | null, actual: number | null, org = ORG) =>
  ({ id, org_id: org, user_id, plan_date, territory_label: label, total_distance_km: total, actual_distance_km: actual });

const stop = (n: number, route_plan_id: string, store_id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id: `rpo-${n}`, route_plan_id, store_id, org_id: ORG, status,
  planned_duration_min: null, checkin_at: null, checkout_at: null, checkin_distance_m: null, geofence_radius_m: null, ...extra,
});

const order = (id: string, salesman_id: string, outlet_id: string, grand_total: number, placed_at: string, status = 'placed', org = ORG) =>
  ({ id, org_id: org, salesman_id, outlet_id, grand_total, placed_at, status });

const att = (id: string, user_id: string, date: string, extra: Record<string, unknown> = {}) =>
  ({ id, org_id: ORG, client_id: null, user_id, date, status: 'checked_out', checkin_at: null, checkout_at: null, total_hours: null, is_regularised: false, ...extra });

export function seed(): Record<string, any[]> {
  return {
    users: [
      user(R1, 'Asha', 'executive', { supervisor_id: S1 }),
      user(R2, 'Bala', 'field_executive', { supervisor_id: S1 }),
      user(R3, 'Chitra', 'executive', { supervisor_id: S2 }),
      user(R4, 'Dev', 'executive', { is_active: false, supervisor_id: S1 }),
      user(S1, 'Meera', 'supervisor'),
      user(S2, 'Ravi', 'supervisor'),
      user(ADMIN, 'Org Admin', 'admin'),
      { ...user(XB, 'Other-org rep', 'executive'), org_id: ORG_B },
    ],
    clients: [],
    cities: [{ id: 'city-1', name: 'Chennai' }, { id: 'city-2', name: 'Madurai' }],
    stores: [
      { id: ST1, org_id: ORG, name: 'Shree Stores', city_id: 'city-1' },
      { id: ST2, org_id: ORG, name: 'Bansal Provision', city_id: 'city-1' },
      { id: ST3, org_id: ORG, name: 'Krishna Kirana', city_id: 'city-2' },
      { id: ST4, org_id: ORG, name: 'Annapurna Foods', city_id: null },
      { id: ST5, org_id: ORG, name: 'Lakshmi Traders', city_id: 'city-1' },
      { id: STX, org_id: ORG_B, name: 'Other-org store', city_id: null },
    ],
    route_plans: [
      plan('P1', R1, '2026-11-09', 'Beat-A', 10, 12.5),
      plan('P2', R1, '2026-11-06', 'Beat-A', 8, null),
      plan('P3', R2, '2026-11-09', 'Beat-B', 6, 7),
      plan('P4', R2, '2026-11-03', 'Beat-B', 5, 5),
      plan('P5', R3, '2026-11-10', 'Beat-C', 9, null),
      plan('P6', R4, '2026-11-09', 'Beat-D', 3, null),              // inactive rep: never counted by the new endpoints
      plan('P7', ADMIN, '2026-11-09', 'Beat-E', 2, null),           // not a field rep
      plan('P8', XB, '2026-11-09', 'Beat-X', 50, 50, ORG_B),        // other org
      plan('P9', R1, '2026-09-20', 'Beat-A', 4, 4),                 // 51 days back: only the 90-day widgets see it
      plan('P10', R3, '2026-11-04', 'Beat-C', 0, null),             // a plan day with no visit at all
      plan('P11', R1, '2026-11-12', 'Beat-A', 4, null),             // future plan
      plan('P12', R1, '2026-11-09', 'Beat-A2', 0, null),            // a second plan (another activity) the same day: ST1 again, still pending - ONE call, already visited on P1
    ],
    route_plan_outlets: [
      // P1  Asha, Mon 11-09
      stop(1, 'P1', ST1, 'visited', { checkin_at: '2026-11-09T04:00:00Z', checkout_at: '2026-11-09T04:20:00Z', planned_duration_min: 15, checkin_distance_m: 40, geofence_radius_m: 100 }),
      stop(2, 'P1', ST2, 'completed', { checkin_at: '2026-11-09T04:40:00Z', checkout_at: '2026-11-09T04:45:00Z', planned_duration_min: 10, checkin_distance_m: 60, geofence_radius_m: 100 }),
      stop(3, 'P1', ST3, 'pending'),
      // P2  Asha, Fri 11-06
      stop(4, 'P2', ST1, 'visited', { checkin_at: '2026-11-06T03:30:00Z', checkout_at: '2026-11-06T04:00:00Z', planned_duration_min: 20, checkin_distance_m: 30, geofence_radius_m: 100 }),
      stop(5, 'P2', ST4, 'pending'),
      // P3  Bala, Mon 11-09 (check-in 250 m from a 100 m geofence; 1 minute on site)
      stop(6, 'P3', ST1, 'visited', { checkin_at: '2026-11-09T05:30:00Z', checkout_at: '2026-11-09T05:31:00Z', planned_duration_min: 5, checkin_distance_m: 250, geofence_radius_m: 100 }),
      stop(7, 'P3', ST2, 'pending'),
      // P4  Bala, Tue 11-03 (no check-out; no geofence stored -> default 100 m, and 150 m is outside it)
      stop(8, 'P4', ST2, 'visited', { checkin_at: '2026-11-03T04:30:00Z', checkin_distance_m: 150 }),
      // P5  Chitra, today (60 m from a 50 m geofence)
      stop(9, 'P5', ST3, 'visited', { checkin_at: '2026-11-10T03:45:00Z', checkout_at: '2026-11-10T04:15:00Z', planned_duration_min: 25, checkin_distance_m: 60, geofence_radius_m: 50 }),
      stop(10, 'P5', ST4, 'skipped'),
      // look-alikes that must not count
      stop(11, 'P6', ST1, 'visited', { checkin_at: '2026-11-09T04:00:00Z', checkout_at: '2026-11-09T05:00:00Z' }),
      stop(12, 'P7', ST1, 'visited', { checkin_at: '2026-11-09T04:00:00Z', checkout_at: '2026-11-09T05:00:00Z' }),
      { ...stop(13, 'P8', STX, 'visited', { checkin_at: '2026-11-09T04:00:00Z', checkout_at: '2026-11-09T05:00:00Z' }), org_id: ORG_B },
      // P9  Asha, 51 days back
      stop(14, 'P9', ST5, 'visited', { checkin_at: '2026-09-20T04:00:00Z', checkout_at: '2026-09-20T04:30:00Z' }),
      // P10 Chitra, Wed 11-04: planned, never visited
      stop(15, 'P10', ST1, 'pending'),
      // P11 future
      stop(16, 'P11', ST1, 'pending'),
      // P12 duplicate of Asha's 11-09 ST1 call on another plan
      stop(17, 'P12', ST1, 'pending'),
    ],
    orders: [
      order('O1', R1, ST1, 1000, '2026-11-09T05:00:00Z'),
      order('O2', R1, ST2, 500, '2026-11-09T06:00:00Z', 'invoiced'),
      order('O3', R2, ST1, 800, '2026-11-09T07:00:00Z', 'approved'),
      order('O4', R1, ST1, 9999, '2026-11-06T05:00:00Z', 'cancelled'),
      order('O5', R2, ST2, 7777, '2026-11-03T05:00:00Z', 'draft'),
      order('O6', R3, ST3, 700, '2026-11-10T02:00:00Z'),
      order('O7', R1, ST5, 300, '2026-10-05T05:00:00Z'),
      order('O8', R1, ST2, 200, '2026-10-01T05:00:00Z'),
      order('O9', ADMIN, ST1, 5000, '2026-11-09T05:00:00Z'),            // not a field rep's order
      order('OX', XB, STX, 12345, '2026-11-09T05:00:00Z', 'placed', ORG_B),
    ],
    attendance: [
      att('A1', R1, '2026-11-09', { checkin_at: '2026-11-09T03:30:00Z', checkout_at: '2026-11-09T12:00:00Z', total_hours: 8.5 }),            // 09:00 -> 17:30
      att('A2', R1, '2026-11-06', { status: 'checked_in', checkin_at: '2026-11-06T03:45:00Z' }),                                           // 09:15, never checked out
      att('A3', R1, '2026-11-05', { status: 'absent' }),
      att('A4', R1, '2026-11-04', { checkin_at: '2026-11-04T04:00:00Z', checkout_at: '2026-11-04T11:00:00Z', is_regularised: true }),        // 09:30 -> 16:30, hours from the stamps = 7.0
      att('A5', R2, '2026-11-09', { checkin_at: '2026-11-09T04:30:00Z', checkout_at: '2026-11-09T11:30:00Z', total_hours: 7 }),              // 10:00 -> 17:00
      att('A6', R2, '2026-11-10', { status: 'checked_in', checkin_at: '2026-11-10T03:30:00Z' }),                                           // today, still open
      att('A7', ADMIN, '2026-11-09', { checkin_at: '2026-11-09T02:30:00Z', checkout_at: '2026-11-09T11:30:00Z' }),                         // 08:00 -> 17:00, no stored hours -> 9.0
      { ...att('AX', XB, '2026-11-09', { checkin_at: '2026-11-09T03:30:00Z', total_hours: 4 }), org_id: ORG_B },
    ],
    security_alerts: [
      { id: 'SA1', org_id: ORG, user_id: R1, type: 'MOCK_LOCATION', created_at: '2026-11-08T05:00:00Z' },
      { id: 'SA2', org_id: ORG, user_id: R1, type: 'MOCK_LOCATION', created_at: '2026-11-09T05:00:00Z' },
      { id: 'SA3', org_id: ORG, user_id: R1, type: 'VPN_DETECTED', created_at: '2026-11-09T06:00:00Z' },
      { id: 'SA4', org_id: ORG, user_id: R1, type: 'MOCK_LOCATION', created_at: '2026-10-01T05:00:00Z' },            // outside the 30-day / report window
      { id: 'SA5', org_id: ORG_B, user_id: XB, type: 'VPN_DETECTED', created_at: '2026-11-09T05:00:00Z' },
    ],
    work_activity: [
      { id: 'W1', org_id: ORG, user_id: R3, is_suspect: true, captured_at: '2026-11-09T05:00:00Z' },
      { id: 'W2', org_id: ORG, user_id: R3, is_suspect: true, captured_at: '2026-11-10T05:00:00Z' },
      { id: 'W3', org_id: ORG, user_id: R3, is_suspect: false, captured_at: '2026-11-10T05:30:00Z' },
      { id: 'W4', org_id: ORG_B, user_id: XB, is_suspect: true, captured_at: '2026-11-09T05:00:00Z' },
    ],
  };
}
