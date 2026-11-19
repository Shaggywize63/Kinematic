/**
 * The route gate for the expense approver endpoints (/claims/all, /claims/pending, /claims/summary,
 * /claims/export, /claims/bulk-decision, /claims/:id/decision). It must admit real managers/admins but
 * never a field rep whose org role is scoped to 'own' — even when that rep carries an admin-ish legacy
 * role (sub_admin) on a flat field-force tenant. This keeps the route gate as strict as isApprover() in
 * the service layer, so the approver surfaces can never leak one individual another's claims.
 */
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import { mayReachApproverEndpoints } from '../src/routes/expenses.routes';

describe('mayReachApproverEndpoints (expense approver route gate)', () => {
  it('admits admins and managers (any non-own scope)', () => {
    expect(mayReachApproverEndpoints('admin', 'all')).toBe(true);
    expect(mayReachApproverEndpoints('admin', null)).toBe(true);
    expect(mayReachApproverEndpoints('super_admin', undefined)).toBe(true);
    expect(mayReachApproverEndpoints('supervisor', 'team')).toBe(true);
    expect(mayReachApproverEndpoints('manager', 'team')).toBe(true);
    expect(mayReachApproverEndpoints('hr', null)).toBe(true);
  });

  it("denies a field rep whose org role is scoped to 'own', even with an admin-ish legacy role", () => {
    expect(mayReachApproverEndpoints('sub_admin', 'own')).toBe(false); // flat field-force rep
    expect(mayReachApproverEndpoints('admin', 'own')).toBe(false);
    expect(mayReachApproverEndpoints('supervisor', 'OWN')).toBe(false); // case-insensitive
  });

  it('denies ordinary field reps and unknown / blank roles', () => {
    expect(mayReachApproverEndpoints('executive', null)).toBe(false);
    expect(mayReachApproverEndpoints('executive', 'own')).toBe(false);
    expect(mayReachApproverEndpoints('', null)).toBe(false);
    expect(mayReachApproverEndpoints(null, null)).toBe(false);
    expect(mayReachApproverEndpoints(undefined, undefined)).toBe(false);
  });
});
