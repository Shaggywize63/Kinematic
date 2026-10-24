/**
 * Route-level own-scope decision for the CRM entity surfaces (leads, deals,
 * contacts, accounts) — list, export, global search, analytics.
 *
 * The bug: own-scope was keyed off the "Consumer Champion" designation NAME
 * (leads) / only the hierarchy subtree (deals, contacts, accounts), so any
 * other data_scope='own' designation (e.g. Aadinath's Sales Executive /
 * Service Engineer) on a non-hierarchy client saw every record in the client.
 *
 * The fix: data_scope='own' is strictly own-only on every NON-default project
 * (owner_id = self), while the Tata `default` project is left unchanged
 * (golden rule).
 *
 *   - leadsOwnOnly(req, me)        → feeds the leads `ownOnly` flag.
 *   - crmOwnScope(req, me)         → shared predicate behind both.
 *   - crmVisibleOwnerIds(req)      → owner-id set for deals/contacts/accounts;
 *                                    [self] for own on non-default, hierarchy
 *                                    subtree when RBAC is on, else null.
 */
import type { Request } from 'express';

// crmVisibleOwnerIds reaches Supabase (clients.settings → uses_hierarchy_rbac).
// Mock the data layer so the hierarchy gate resolves without a real DB; the
// pure predicates (crmOwnScope / leadsOwnOnly) don't touch it.
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase');

import { leadsOwnOnly, crmOwnScope, crmVisibleOwnerIds } from '../src/routes/crm.routes';

const SELF = '22222222-2222-2222-2222-222222222222';

const req = (projectKey?: string, user?: Record<string, unknown>): Request =>
  ({ projectKey, headers: {}, user } as unknown as Request);

const me = (data_scope: string | null, name = 'Sales Executive') =>
  ({ org_role_name: name, org_role_data_scope: data_scope });

beforeEach(() => __mock.reset());

describe('crmOwnScope — shared own-scope predicate (leads + deals + contacts + accounts)', () => {
  it('is true for a data_scope=own designation on a non-default project', () => {
    expect(crmOwnScope(req('kinematic'), me('own', 'Sales Executive'))).toBe(true);
    expect(crmOwnScope(req('aadinath'), me('own', 'Service Engineer'))).toBe(true);
  });

  it('is false on the Tata default project (golden rule — unchanged)', () => {
    expect(crmOwnScope(req('default'), me('own', 'Area Sales Officer'))).toBe(false);
  });

  it('is false for team / all scope', () => {
    expect(crmOwnScope(req('kinematic'), me('team'))).toBe(false);
    expect(crmOwnScope(req('kinematic'), me('all'))).toBe(false);
    expect(crmOwnScope(req('kinematic'), undefined)).toBe(false);
  });
});

describe('leadsOwnOnly — leads visibility decision', () => {
  it('a frontline Consumer Champion is own-only on EVERY project', () => {
    const champ = me('own', 'Consumer Champion');
    expect(leadsOwnOnly(req('default'), champ)).toBe(true);
    expect(leadsOwnOnly(req('kinematic'), champ)).toBe(true);
  });

  it('a data_scope=own designation is own-only on a non-default project (the fix)', () => {
    expect(leadsOwnOnly(req('kinematic'), me('own', 'Sales Executive'))).toBe(true);
    expect(leadsOwnOnly(req('kinematic'), me('own', 'Service Engineer'))).toBe(true);
  });

  it('leaves the Tata default project unchanged: a non-champion own-scope ASO is NOT own-only', () => {
    expect(leadsOwnOnly(req('default'), me('own', 'Area Sales Officer'))).toBe(false);
    expect(leadsOwnOnly(req('default'), me('own', 'Consumer Champion'))).toBe(true);
  });

  it('team / all scope designations are never own-only', () => {
    expect(leadsOwnOnly(req('kinematic'), me('all', 'CRM Admin'))).toBe(false);
    expect(leadsOwnOnly(req('kinematic'), me('team', 'Manager'))).toBe(false);
    expect(leadsOwnOnly(req('kinematic'), me('team', 'Consumer Champion Manager'))).toBe(false);
  });

  it('a missing user / designation is not own-only', () => {
    expect(leadsOwnOnly(req('kinematic'), undefined)).toBe(false);
  });
});

describe('crmVisibleOwnerIds — deals / contacts / accounts owner set (hierarchy RBAC OFF)', () => {
  // No client_id on the user → useHierarchyRbac short-circuits to false, so
  // maybeSubtreeOwnerIds returns null and crmOwnScope decides.
  it('restricts a data_scope=own caller to themselves on a non-default project', async () => {
    const ids = await crmVisibleOwnerIds(req('kinematic', { id: SELF, org_role_data_scope: 'own' }) as never);
    expect(ids).toEqual([SELF]);
  });

  it('returns null (no owner filter) for an all-scope caller', async () => {
    const ids = await crmVisibleOwnerIds(req('kinematic', { id: SELF, org_role_data_scope: 'all' }) as never);
    expect(ids).toBeNull();
  });

  it('leaves the Tata default project unrestricted for an own-scope caller', async () => {
    const ids = await crmVisibleOwnerIds(req('default', { id: SELF, org_role_data_scope: 'own' }) as never);
    expect(ids).toBeNull();
  });

  it('a data_scope=own caller with no id collapses to an empty set (sees nothing, never everything)', async () => {
    const ids = await crmVisibleOwnerIds(req('kinematic', { org_role_data_scope: 'own' }) as never);
    expect(ids).toEqual([]);
  });
});
