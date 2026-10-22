/**
 * Route-level own-scope decision for the LEADS surfaces (list, export, global
 * search, analytics). `leadsOwnOnly(req, me)` is what decides whether a caller
 * is restricted to leads they personally own.
 *
 * The bug this pins down: own-scope was keyed off the "Consumer Champion"
 * designation NAME (isFrontlineChampion), so any other data_scope='own'
 * designation (e.g. Aadinath's Sales Executive / Service Engineer) fell through
 * and saw every lead in the client. The fix makes data_scope='own' strictly
 * own-only on every NON-default project, while leaving the Tata `default`
 * project's historical city-broadened ASO behaviour untouched (golden rule).
 */
import type { Request } from 'express';
import { leadsOwnOnly } from '../src/routes/crm.routes';

const req = (projectKey?: string): Request =>
  ({ projectKey, headers: {} } as unknown as Request);

const me = (data_scope: string | null, name = 'Sales Executive') =>
  ({ org_role_name: name, org_role_data_scope: data_scope });

describe('leadsOwnOnly — leads visibility decision', () => {
  it('a frontline Consumer Champion is own-only on EVERY project', () => {
    const champ = me('own', 'Consumer Champion');
    expect(leadsOwnOnly(req('default'), champ)).toBe(true);
    expect(leadsOwnOnly(req('kinematic'), champ)).toBe(true);
  });

  it('a data_scope=own designation is own-only on a non-default project (the fix)', () => {
    expect(leadsOwnOnly(req('kinematic'), me('own', 'Sales Executive'))).toBe(true);
    expect(leadsOwnOnly(req('kinematic'), me('own', 'Service Engineer'))).toBe(true);
    expect(leadsOwnOnly(req('aadinath'), me('own', 'Service Engineer'))).toBe(true);
  });

  it('leaves the Tata default project unchanged: a non-champion own-scope ASO is NOT own-only', () => {
    expect(leadsOwnOnly(req('default'), me('own', 'Area Sales Officer'))).toBe(false);
    expect(leadsOwnOnly(req('default'), me('own', 'Sales Executive'))).toBe(false);
    // ...but a frontline Champion on default is still own-only (unchanged).
    expect(leadsOwnOnly(req('default'), me('own', 'Consumer Champion'))).toBe(true);
  });

  it('team / all scope designations are never own-only', () => {
    expect(leadsOwnOnly(req('kinematic'), me('all', 'CRM Admin'))).toBe(false);
    expect(leadsOwnOnly(req('kinematic'), me('team', 'Manager'))).toBe(false);
    // A Consumer Champion MANAGER (team scope) manages a pod — not own-only.
    expect(leadsOwnOnly(req('kinematic'), me('team', 'Consumer Champion Manager'))).toBe(false);
    expect(leadsOwnOnly(req('default'), me('team', 'Consumer Champion Manager'))).toBe(false);
  });

  it('a missing user / designation is not own-only (fails open to the broader scope checks)', () => {
    expect(leadsOwnOnly(req('kinematic'), undefined)).toBe(false);
    expect(leadsOwnOnly(req('kinematic'), me(null, 'Unknown'))).toBe(false);
  });
});
