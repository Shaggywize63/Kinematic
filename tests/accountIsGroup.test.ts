/**
 * `is_group` — the parent/group end of the account hierarchy.
 *
 * `parent_account_id` (the CHILD end) was already on accountSchema, so pointing a plant at its
 * group always saved. `is_group` was not, and zod strips unknown keys silently — so "Make this a
 * parent account" from the web account page would have returned 200 with the flag quietly dropped,
 * and the tree would have kept rendering the account as an ordinary company. That is exactly the
 * half-wired failure the repo guide warns about, so pin both ends of the link here.
 */
import { accountSchema } from '../src/validators/crm.validators';

describe('accountSchema — is_group', () => {
  it('keeps is_group on create (true and false both survive)', () => {
    for (const value of [true, false]) {
      const parsed = accountSchema.parse({ name: 'NTPC Limited', is_group: value });
      expect(parsed).toHaveProperty('is_group', value);
    }
  });

  it('keeps is_group on PATCH, which uses accountSchema.partial()', () => {
    const parsed = accountSchema.partial().parse({ is_group: true });
    expect(parsed).toEqual({ is_group: true });
  });

  it('is optional — an account write that says nothing about grouping is unchanged', () => {
    const parsed = accountSchema.parse({ name: 'JSW Cement Limited - Jajpur, Odisha' });
    expect(parsed).not.toHaveProperty('is_group');
  });

  it('rejects a non-boolean rather than coercing it', () => {
    // A truthy string must not quietly become `true`: the UI toggle sends a real boolean, and
    // anything else means a caller is confused about the field.
    for (const bad of ['true', 1, 'yes', {}]) {
      expect(() => accountSchema.partial().parse({ is_group: bad })).toThrow();
    }
  });

  it('carries both ends of the hierarchy in one write', () => {
    // Promoting a group and re-parenting a child are separate writes in the UI, but nothing stops
    // them arriving together, and both keys must survive.
    const parentId = '11111111-2222-3333-4444-555555555555';
    const parsed = accountSchema.partial().parse({ is_group: true, parent_account_id: parentId });
    expect(parsed).toEqual({ is_group: true, parent_account_id: parentId });
  });
});
