/**
 * New-user module permissions / city assignments are written with only the columns the tables
 * have (user_id + module_id | city_id). Writing an org_id made every insert fail silently, so
 * cities and modules picked while creating a user were dropped.
 */
import { userAccessRows } from '../src/lib/userAccessRows';

describe('userAccessRows', () => {
  it('builds rows with exactly the real columns and no org_id', () => {
    const { permissionRows, cityRows } = userAccessRows('u1', ['crm', 'people'], ['c1', 'c2']);
    expect(permissionRows).toEqual([{ user_id: 'u1', module_id: 'crm' }, { user_id: 'u1', module_id: 'people' }]);
    expect(cityRows).toEqual([{ user_id: 'u1', city_id: 'c1' }, { user_id: 'u1', city_id: 'c2' }]);
    for (const r of [...permissionRows, ...cityRows]) expect(r).not.toHaveProperty('org_id');
  });

  it('de-duplicates, trims and drops blanks / non-strings (a repeated id would break the primary key)', () => {
    const { permissionRows, cityRows } = userAccessRows('u1', ['crm', ' crm ', '', null, 5, 'people'], ['c1', 'c1', '  ']);
    expect(permissionRows.map((r) => r.module_id)).toEqual(['crm', 'people']);
    expect(cityRows.map((r) => r.city_id)).toEqual(['c1']);
  });

  it('returns nothing when the lists are missing or not arrays', () => {
    for (const v of [undefined, null, 'crm', {}, 7]) {
      expect(userAccessRows('u1', v, v)).toEqual({ permissionRows: [], cityRows: [] });
    }
  });
});
