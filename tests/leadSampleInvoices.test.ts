/**
 * Sample invoices on a lead (Spark & Ray).
 *
 * A lead carries a free-form list of sample-invoice NUMBERS (just strings) in
 * the existing `custom_fields` jsonb under `sample_invoices` — no new column /
 * table / migration. The list already round-trips generically through the
 * custom_fields blob; the backend only NORMALIZES its shape on write.
 *
 * These tests lock three things:
 *   1. normalizeSampleInvoicesField — trim / drop-blank / dedupe / caps, and
 *      preservation of every OTHER custom_fields key (pure, no DB);
 *   2. the WRITE path (createLead + updateLead) persists the NORMALIZED list to
 *      crm_leads.custom_fields;
 *   3. the READ-back row carries the normalized list alongside other keys.
 *
 * The scoring engine is stubbed (as in leadRecompute.test.ts) so the
 * assertions are about custom_fields persistence, not the heuristic maths.
 */
import { createSupabaseMock, RecordedChain } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

jest.mock('../src/services/crm/ai/leadScoring.service', () => ({
  computeUnifiedScore: jest.fn(async () => ({
    score: 50, grade: 'C', breakdown: { model: 'heuristic_v2', factors: [] },
    engagement: {}, profile: 'b2b',
  })),
  rerankLeadAsync: jest.fn(async () => undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import * as leads from '../src/services/crm/leads.service';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const LEAD = '33333333-3333-3333-3333-333333333333';
const SELF = '22222222-2222-2222-2222-222222222222';

// Echo helper: when a chain writes (insert/update), reflect the written row
// back out so the service's `.select('*').single()` returns what was persisted
// (the read-back). A plain select returns `base`.
const echo = (base: Record<string, unknown>) => (chain: RecordedChain) => {
  const written = chain.ops.find((o) => o.method === 'insert' || o.method === 'update')?.args[0] as
    | Record<string, unknown>
    | undefined;
  return { data: [{ ...base, ...(written ?? {}) }], error: null };
};

const crmLeadsWrites = () =>
  __mock.chainsFor('crm_leads')
    .map((c) => c.ops.find((o) => o.method === 'insert' || o.method === 'update')?.args[0] as Record<string, unknown> | undefined)
    .filter((p): p is Record<string, unknown> => !!p);

beforeEach(() => {
  __mock.reset();
  jest.clearAllMocks();
  // No custom-field defs → validateAndStampCustomFields passes keys through.
  __mock.setDefault('crm_custom_field_defs', { data: [] });
  __mock.setDefault('crm_settings', { data: { config: {} } });
});

// ── 1. Pure normalization ────────────────────────────────────────────────────
describe('normalizeSampleInvoicesField', () => {
  it('is a no-op when the key is absent (other keys untouched)', () => {
    const out = leads.normalizeSampleInvoicesField({ campaign: 'General Calls', volume_kg: 5 });
    expect(out).toEqual({ campaign: 'General Calls', volume_kg: 5 });
    expect(out).not.toHaveProperty('sample_invoices');
  });

  it('tolerates null / undefined input', () => {
    expect(leads.normalizeSampleInvoicesField(null)).toEqual({});
    expect(leads.normalizeSampleInvoicesField(undefined)).toEqual({});
  });

  it('trims each entry and drops blank / whitespace-only ones', () => {
    const out = leads.normalizeSampleInvoicesField({
      sample_invoices: ['  INV-1 ', '', '   ', 'INV-2', '\t\n'],
    });
    expect(out.sample_invoices).toEqual(['INV-1', 'INV-2']);
  });

  it('dedupes on exact string match, keeping the first occurrence (order preserved)', () => {
    const out = leads.normalizeSampleInvoicesField({
      sample_invoices: ['INV-1', 'INV-2', 'INV-1', ' INV-2 ', 'INV-3'],
    });
    expect(out.sample_invoices).toEqual(['INV-1', 'INV-2', 'INV-3']);
  });

  it('caps each entry at 60 chars (truncates the overflow)', () => {
    const long = 'A'.repeat(75);
    const out = leads.normalizeSampleInvoicesField({ sample_invoices: [long, 'B'] });
    const arr = out.sample_invoices as string[];
    expect(arr[0]).toHaveLength(60);
    expect(arr[0]).toBe('A'.repeat(60));
    expect(arr[1]).toBe('B');
  });

  it('two over-length numbers sharing a 60-char prefix collapse to one (no dup in output)', () => {
    const out = leads.normalizeSampleInvoicesField({
      sample_invoices: ['A'.repeat(60) + 'X', 'A'.repeat(60) + 'Y'],
    });
    expect(out.sample_invoices).toEqual(['A'.repeat(60)]);
  });

  it('caps the list at 100 entries (drops the overflow, keeps the first 100)', () => {
    const many = Array.from({ length: 130 }, (_, i) => `INV-${i}`);
    const out = leads.normalizeSampleInvoicesField({ sample_invoices: many });
    const arr = out.sample_invoices as string[];
    expect(arr).toHaveLength(100);
    expect(arr[0]).toBe('INV-0');
    expect(arr[99]).toBe('INV-99');
  });

  it('coerces a non-array value and non-string entries to clean strings', () => {
    expect(leads.normalizeSampleInvoicesField({ sample_invoices: 'INV-9' }).sample_invoices).toEqual(['INV-9']);
    expect(leads.normalizeSampleInvoicesField({ sample_invoices: [123, 'INV-1', null] }).sample_invoices)
      .toEqual(['123', 'INV-1']);
    expect(leads.normalizeSampleInvoicesField({ sample_invoices: '' }).sample_invoices).toEqual([]);
  });

  it('preserves all OTHER custom_fields keys alongside the normalized list', () => {
    const out = leads.normalizeSampleInvoicesField({
      sample_invoices: [' INV-1 ', 'INV-1'],
      campaign: 'After-Sales',
      __important: true,
      volume_kg: 12,
    });
    expect(out).toEqual({
      sample_invoices: ['INV-1'],
      campaign: 'After-Sales',
      __important: true,
      volume_kg: 12,
    });
  });

  it('returns a new object and never mutates the input', () => {
    const input = { sample_invoices: [' INV-1 ', ' INV-1 '] };
    const out = leads.normalizeSampleInvoicesField(input);
    expect(input.sample_invoices).toEqual([' INV-1 ', ' INV-1 ']); // unchanged
    expect(out).not.toBe(input);
    expect(out.sample_invoices).toEqual(['INV-1']);
  });
});

// ── 2 + 3. Write + read-back round-trip ──────────────────────────────────────
describe('createLead — sample_invoices round-trip', () => {
  it('persists the NORMALIZED list to custom_fields and returns it on the row', async () => {
    __mock.setDefault('crm_leads', echo({ id: 'L1', org_id: ORG, client_id: null, status: 'new' }));

    const created = await leads.createLead({
      org_id: ORG,
      user_id: SELF,
      skipDedup: true,
      payload: {
        first_name: 'Acme',
        owner_id: SELF,
        client_id: null,
        custom_fields: {
          // messy input: duplicates, blanks, untrimmed, an unrelated key
          sample_invoices: [' INV-1 ', 'INV-1', '', 'INV-2'],
          campaign: 'General Calls',
        } as Record<string, unknown>,
      } as any,
    });

    // READ-back row carries the cleaned list + the preserved key.
    const cf = (created as any).custom_fields as Record<string, unknown>;
    expect(cf.sample_invoices).toEqual(['INV-1', 'INV-2']);
    expect(cf.campaign).toBe('General Calls');

    // WRITE: the row actually inserted into crm_leads carried the normalized list.
    const insert = crmLeadsWrites()[0];
    expect((insert.custom_fields as Record<string, unknown>).sample_invoices).toEqual(['INV-1', 'INV-2']);
  });
});

describe('updateLead — sample_invoices round-trip', () => {
  it('normalizes on PATCH and preserves pre-existing custom_fields keys', async () => {
    // Pre-existing row already has an unrelated custom field.
    const before = {
      id: LEAD, org_id: ORG, client_id: null, status: 'working',
      owner_id: SELF, custom_fields: { campaign: 'After-Sales' },
    };
    __mock.setDefault('crm_leads', echo(before));

    const updated = await leads.updateLead(
      ORG,
      LEAD,
      {
        custom_fields: {
          sample_invoices: ['INV-9', ' INV-9 ', 'INV-10', '  '],
          region: 'West',
        } as Record<string, unknown>,
      } as any,
      SELF,
    );

    const cf = (updated as any).custom_fields as Record<string, unknown>;
    // normalized list
    expect(cf.sample_invoices).toEqual(['INV-9', 'INV-10']);
    // new sibling key kept
    expect(cf.region).toBe('West');
    // pre-existing key merged through (updateLead merges before + patch)
    expect(cf.campaign).toBe('After-Sales');

    // The write to crm_leads carried the normalized list.
    const wroteNormalized = crmLeadsWrites().some((w) => {
      const scf = w.custom_fields as Record<string, unknown> | undefined;
      return scf && Array.isArray(scf.sample_invoices)
        && JSON.stringify(scf.sample_invoices) === JSON.stringify(['INV-9', 'INV-10']);
    });
    expect(wroteNormalized).toBe(true);
  });

  it('leaves custom_fields that omit sample_invoices unchanged (no key injected)', async () => {
    const before = {
      id: LEAD, org_id: ORG, client_id: null, status: 'working',
      owner_id: SELF, custom_fields: {},
    };
    __mock.setDefault('crm_leads', echo(before));

    const updated = await leads.updateLead(
      ORG, LEAD,
      { custom_fields: { campaign: 'General Calls' } as Record<string, unknown> } as any,
      SELF,
    );
    const cf = (updated as any).custom_fields as Record<string, unknown>;
    expect(cf).not.toHaveProperty('sample_invoices');
    expect(cf.campaign).toBe('General Calls');
  });
});
