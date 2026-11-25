/**
 * Which custom-field DEFS govern a write — the (org, client) scoping of
 * `loadDefs` inside `validateAndStampCustomFields`.
 *
 * `crm_custom_field_defs` rows are either UNIVERSAL (`client_id` NULL — they
 * apply to every client in the org) or CLIENT-SCOPED (`client_id` set). Every
 * caller of `validateAndStampCustomFields` passes the client OF THE ROW BEING
 * WRITTEN (`payload.client_id ?? null`, or the existing row's `client_id`), so
 * the def set has to follow the row:
 *
 *   - a client-scoped row  -> universal + that client's defs;
 *   - an org-level row     -> universal defs ONLY.
 *
 * The org-level half used to be unscoped: `if (clientId)` added the client
 * filter and there was no `else`, so a request carrying no client loaded EVERY
 * client's defs for the org. One client's rules — type coercion, hidden-key
 * stripping, required enforcement, formula stamping — were then applied to a
 * row that belonged to a different client, or to none. These tests pin both
 * halves so neither can drift back.
 *
 * Sibling rule-readers that already scope this way, for reference:
 * `enforceLeadRequiredFields` / `stripHiddenLeadFields` (crm_settings, in
 * crm.routes.ts), `leadCustomDefs` (this same table, in
 * ai/extractLead.service.ts) and `exactClient` (productImport.service.ts).
 */
import { createSupabaseMock, type RecordedChain } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import { validateAndStampCustomFields } from '../src/services/crm/customFields.service';
import { AppError } from '../src/utils';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const CLIENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLIENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_ORG = '00000000-0000-0000-0000-0000000000bb';

type Def = Record<string, unknown>;

/**
 * The lead field defs every test runs against: one universal, one per client,
 * plus a hidden client-scoped field and a row from another org.
 *
 * `budget` / `dealer_code` / `plant_code` are all `number`, so "which defs got
 * loaded" is observable from the OUTSIDE: a key whose def is in scope is
 * coerced ("7" -> 7) or rejected ("abc" -> 400 BAD_CUSTOM_FIELD), while a key
 * whose def is NOT in scope is an unknown key and passes through untouched.
 */
const DEFS: Def[] = [
  { field_key: 'budget', field_type: 'number', label: 'Budget', org_id: ORG, entity_type: 'lead', is_active: true, client_id: null },
  { field_key: 'dealer_code', field_type: 'number', label: 'Dealer code', required: true, org_id: ORG, entity_type: 'lead', is_active: true, client_id: CLIENT_A },
  { field_key: 'aadhaar', field_type: 'text', label: 'Aadhaar', hidden: true, org_id: ORG, entity_type: 'lead', is_active: true, client_id: CLIENT_A },
  { field_key: 'plant_code', field_type: 'number', label: 'Plant code', required: true, org_id: ORG, entity_type: 'lead', is_active: true, client_id: CLIENT_B },
  { field_key: 'budget', field_type: 'number', label: 'Budget', org_id: OTHER_ORG, entity_type: 'lead', is_active: true, client_id: null },
];

/** `client_id.is.null,client_id.eq.<uuid>` — the only `.or()` loadDefs builds. */
const SHARED_OR = /^client_id\.is\.null,client_id\.eq\.([0-9a-f-]+)$/;

/**
 * A def table that APPLIES what the query asked for, including the `client_id`
 * `.or()` (which helpers/fakeTable.ts deliberately doesn't evaluate) — so the
 * assertions below are about which defs reached the validator, not about which
 * filters it happened to build.
 */
function defTable(rows: Def[] = DEFS) {
  return (chain: RecordedChain) => {
    let out = rows.slice();
    for (const op of chain.ops) {
      if (op.method === 'eq') {
        const [col, val] = op.args as [string, unknown];
        out = out.filter((r) => r[col] === val);
      } else if (op.method === 'is') {
        const [col, val] = op.args as [string, unknown];
        out = out.filter((r) => (r[col] ?? null) === val);
      } else if (op.method === 'or') {
        const m = SHARED_OR.exec(String(op.args[0]));
        if (!m) throw new Error(`unexpected .or() on crm_custom_field_defs: ${String(op.args[0])}`);
        out = out.filter((r) => r.client_id === null || r.client_id === m[1]);
      }
    }
    return { data: out };
  };
}

const lastChain = () => {
  const chains = __mock.chainsFor('crm_custom_field_defs');
  return chains[chains.length - 1];
};
const applied = (chain: RecordedChain, method: string, col: string) =>
  chain.ops.some((o) => o.method === method && o.args[0] === col);

beforeEach(() => {
  __mock.reset();
  __mock.setDefault('crm_custom_field_defs', defTable());
});

describe('loadDefs — a client-scoped write sees universal + that client\'s defs', () => {
  it('coerces both a universal and the client\'s own field', async () => {
    const out = await validateAndStampCustomFields(ORG, CLIENT_A, 'lead', { budget: '5', dealer_code: '7' });
    expect(out).toEqual({ budget: 5, dealer_code: 7 });
  });

  it('strips a key the client has hidden (DPDP §6(1) data minimisation)', async () => {
    const out = await validateAndStampCustomFields(ORG, CLIENT_A, 'lead', { aadhaar: '1234 5678 9012', budget: '5' });
    expect(out).toEqual({ budget: 5 });
  });

  it('enforces the client\'s own required field', async () => {
    await expect(
      validateAndStampCustomFields(ORG, CLIENT_A, 'lead', { budget: 5 }, { enforceRequired: true }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'REQUIRED_CUSTOM_FIELD', message: 'Dealer code is required.' });
  });

  it('does NOT apply another client\'s def — the key stays a free-form passthrough', async () => {
    // `plant_code` is client B's number field. On a client-A write it is an
    // unknown key: not coerced, not rejected, and not required.
    const out = await validateAndStampCustomFields(
      ORG, CLIENT_A, 'lead', { dealer_code: 1, plant_code: 'abc' }, { enforceRequired: true },
    );
    expect(out).toEqual({ dealer_code: 1, plant_code: 'abc' });
  });

  it('builds the shared-or filter, not the universal-only one', async () => {
    await validateAndStampCustomFields(ORG, CLIENT_A, 'lead', { budget: '5' });
    const chain = lastChain();
    expect(chain.eqs).toMatchObject({ org_id: ORG, entity_type: 'lead', is_active: true });
    expect(chain.ors).toEqual([`client_id.is.null,client_id.eq.${CLIENT_A}`]);
    expect(applied(chain, 'is', 'client_id')).toBe(false);
  });
});

describe('loadDefs — an org-level write sees ONLY universal defs', () => {
  it('still coerces a universal field', async () => {
    const out = await validateAndStampCustomFields(ORG, null, 'lead', { budget: '5' });
    expect(out).toEqual({ budget: 5 });
  });

  it('still enforces a universal required field', async () => {
    __mock.setDefault('crm_custom_field_defs', defTable([
      { field_key: 'budget', field_type: 'number', label: 'Budget', required: true, org_id: ORG, entity_type: 'lead', is_active: true, client_id: null },
    ]));
    await expect(
      validateAndStampCustomFields(ORG, null, 'lead', {}, { enforceRequired: true }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'REQUIRED_CUSTOM_FIELD', message: 'Budget is required.' });
  });

  it('does not apply any client\'s coercion — an unparseable value is no longer a 400', async () => {
    // Before the org-level branch existed this loaded client A's `dealer_code`
    // number def and threw BAD_CUSTOM_FIELD on a row that is not client A's.
    const out = await validateAndStampCustomFields(ORG, null, 'lead', { dealer_code: 'abc', plant_code: '7' });
    expect(out).toEqual({ dealer_code: 'abc', plant_code: '7' });
  });

  it('does not apply any client\'s hidden flag', async () => {
    const out = await validateAndStampCustomFields(ORG, null, 'lead', { aadhaar: 'kept' });
    expect(out).toEqual({ aadhaar: 'kept' });
  });

  it('does not enforce any client\'s required field', async () => {
    // Two clients with different required keys previously made this
    // unsatisfiable: whichever def came back first 400'd the create.
    await expect(
      validateAndStampCustomFields(ORG, null, 'lead', { budget: 5 }, { enforceRequired: true }),
    ).resolves.toEqual({ budget: 5 });
  });

  it('does not stamp any client\'s formula over a sent value', async () => {
    __mock.setDefault('crm_custom_field_defs', defTable([
      ...DEFS,
      { field_key: 'score', field_type: 'formula', formula: '{budget} * 2', label: 'Score', org_id: ORG, entity_type: 'lead', is_active: true, client_id: CLIENT_A },
    ]));
    // Client A's formula recomputes `score`; an org-level write must not.
    await expect(validateAndStampCustomFields(ORG, CLIENT_A, 'lead', { budget: 5, score: 99 }))
      .resolves.toEqual({ budget: 5, score: 10 });
    await expect(validateAndStampCustomFields(ORG, null, 'lead', { budget: 5, score: 99 }))
      .resolves.toEqual({ budget: 5, score: 99 });
  });

  it('filters on client_id IS NULL rather than leaving the query unscoped', async () => {
    await validateAndStampCustomFields(ORG, null, 'lead', { budget: '5' });
    const chain = lastChain();
    expect(chain.eqs).toMatchObject({ org_id: ORG, entity_type: 'lead', is_active: true });
    expect(chain.ors).toEqual([]);
    expect(chain.ops.some((o) => o.method === 'is' && o.args[0] === 'client_id' && o.args[1] === null)).toBe(true);
  });
});

describe('loadDefs — scoping holds for every entity that shares the helper', () => {
  // loadFieldDefs is the single def-loader for lead, contact, account, deal,
  // activity, product AND custom objects (entity_type = object key), so the
  // org-level branch must narrow all of them, not just leads. 'product' reaches
  // it through the bulk import as well as POST/PATCH — see the client-scoping
  // cases in makesBrands.test.ts for that path end to end.
  const entities = ['lead', 'contact', 'account', 'deal', 'activity', 'product', 'requirement'] as const;

  it.each(entities)('%s: an org-level write ignores a client-scoped def', async (entity) => {
    __mock.setDefault('crm_custom_field_defs', defTable([
      { field_key: 'dealer_code', field_type: 'number', label: 'Dealer code', required: true, org_id: ORG, entity_type: entity, is_active: true, client_id: CLIENT_A },
    ]));
    await expect(
      validateAndStampCustomFields(ORG, null, entity, { dealer_code: 'abc' }, { enforceRequired: true }),
    ).resolves.toEqual({ dealer_code: 'abc' });
    expect(lastChain().eqs.entity_type).toBe(entity);
  });

  it.each(entities)('%s: client A\'s write still applies client A\'s def', async (entity) => {
    __mock.setDefault('crm_custom_field_defs', defTable([
      { field_key: 'dealer_code', field_type: 'number', label: 'Dealer code', required: true, org_id: ORG, entity_type: entity, is_active: true, client_id: CLIENT_A },
    ]));
    await expect(
      validateAndStampCustomFields(ORG, CLIENT_A, entity, { dealer_code: 'abc' }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
