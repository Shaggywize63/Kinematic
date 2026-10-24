/**
 * New-user module permissions / city assignments are written with only the columns the tables
 * have (user_id + module_id | city_id). Writing an org_id made every insert fail silently, so
 * cities and modules picked while creating a user were dropped.
 */
import { userAccessRows, modulePermissionsForNewUser } from '../src/lib/userAccessRows';

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

/**
 * A new user under a client with no module list was read as "everything the client is entitled to" — its
 * granted modules PLUS every always-on universal one — so a Bright Kid supervisor saw ~30 menu items while the
 * client admin (whose list was mirrored from the client's grants) saw the 12 assigned. A new user now starts
 * on the client's own grants unless the admin picked modules or attached a designation.
 */
describe('modulePermissionsForNewUser', () => {
  const grants = ['dashboard', 'attendance', 'users'];

  it('starts a client user with no designation and no list on the client\'s granted modules', () => {
    const start = modulePermissionsForNewUser(undefined, { hasOrgRole: false, clientGrants: grants });
    expect(start).toEqual(grants);
    expect(userAccessRows('u1', start, []).permissionRows.map((r) => r.module_id)).toEqual(grants);
  });

  it('treats an empty or junk list the same as no list', () => {
    for (const none of [[], null, undefined, '', 'crm', {}, [' ', 5]]) {
      expect(modulePermissionsForNewUser(none, { hasOrgRole: false, clientGrants: grants })).toEqual(grants);
    }
  });

  it('never overrides modules the admin picked', () => {
    const picked = ['attendance'];
    expect(modulePermissionsForNewUser(picked, { hasOrgRole: false, clientGrants: grants })).toBe(picked);
  });

  it('leaves a user with a hierarchy role alone (the role carries its own modules)', () => {
    expect(modulePermissionsForNewUser(undefined, { hasOrgRole: true, clientGrants: grants })).toBeUndefined();
    expect(modulePermissionsForNewUser([], { hasOrgRole: true, clientGrants: grants })).toEqual([]);
  });

  it('leaves a user with no client, or a client with no grants (legacy), exactly as before', () => {
    expect(modulePermissionsForNewUser(undefined, { hasOrgRole: false, clientGrants: [] })).toBeUndefined();
    expect(userAccessRows('u1', modulePermissionsForNewUser(undefined, { hasOrgRole: false, clientGrants: [] }), []).permissionRows).toEqual([]);
  });

  it('returns a copy, so writing the rows can never mutate the client\'s grant list', () => {
    const start = modulePermissionsForNewUser(undefined, { hasOrgRole: false, clientGrants: grants }) as string[];
    start.push('settings');
    expect(grants).toEqual(['dashboard', 'attendance', 'users']);
  });
});

