/**
 * Service-layer tests for per-client lead statuses
 * (src/services/crm/leadStatuses.ts).
 *
 * The status whitelist used to live in the Zod enum; it now lives here so a
 * client can define its own set in crm_settings.config.lead_statuses. These
 * lock the moved behaviour: the built-in fallback (create excludes terminal
 * states, update allows them), the custom-set path, and the config-aware
 * disqualified-state resolution. Each case uses a distinct client id so the
 * module's short-TTL cache never crosses cases.
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import {
  assertValidLeadStatus,
  parseLeadStatuses,
  disqualifiedStatesFor,
} from '../src/services/crm/leadStatuses';

const ORG = '00000000-0000-0000-0000-0000000000aa';

beforeEach(() => __mock.reset());

describe('parseLeadStatuses', () => {
  it('returns null when nothing is configured', () => {
    expect(parseLeadStatuses({})).toBeNull();
    expect(parseLeadStatuses(null)).toBeNull();
    expect(parseLeadStatuses({ lead_statuses: [] })).toBeNull();
  });

  it('parses, drops invalid slugs, and sorts by position', () => {
    const out = parseLeadStatuses({
      lead_statuses: [
        { value: 'later', position: 8 },
        { value: 'new', label: 'New', position: 1, is_open: true },
        { value: 'BAD CASE', position: 2 }, // invalid slug → dropped
        { value: 'converted', position: 6, is_won: true },
      ],
    });
    expect(out?.map((s) => s.value)).toEqual(['new', 'converted', 'later']);
    expect(out?.[0].label).toBe('New');
  });
});

describe('assertValidLeadStatus — built-in fallback (no custom set)', () => {
  it('create allows open statuses but rejects terminal ones', async () => {
    const C = '11111111-1111-1111-1111-111111111111';
    __mock.setDefault('crm_settings', { data: { config: {} } });
    await expect(assertValidLeadStatus(ORG, C, 'new', true)).resolves.toBeUndefined();
    await expect(assertValidLeadStatus(ORG, C, 'converted', true)).rejects.toMatchObject({
      statusCode: 400, code: 'INVALID_STATUS',
    });
  });

  it('update allows converted/lost and rejects an unknown value', async () => {
    const C = '22222222-2222-2222-2222-222222222222';
    __mock.setDefault('crm_settings', { data: { config: {} } });
    await expect(assertValidLeadStatus(ORG, C, 'converted', false)).resolves.toBeUndefined();
    await expect(assertValidLeadStatus(ORG, C, 'bogus', false)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  it('ignores an undefined/null status (optional field)', async () => {
    const C = '33333333-3333-3333-3333-333333333333';
    await expect(assertValidLeadStatus(ORG, C, undefined, true)).resolves.toBeUndefined();
    await expect(assertValidLeadStatus(ORG, C, null, false)).resolves.toBeUndefined();
  });
});

describe('assertValidLeadStatus / disqualifiedStatesFor — custom set', () => {
  const CUSTOM = {
    config: {
      lead_statuses: [
        { value: 'new', position: 1, is_open: true },
        { value: 'interested', position: 3, is_open: true },
        { value: 'not_interested', position: 7, is_lost: true },
      ],
    },
  };

  it('accepts a configured status and rejects a built-in that is not configured', async () => {
    const C = '44444444-4444-4444-4444-444444444444';
    __mock.setDefault('crm_settings', { data: CUSTOM });
    await expect(assertValidLeadStatus(ORG, C, 'interested', true)).resolves.toBeUndefined();
    await expect(assertValidLeadStatus(ORG, C, 'working', true)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  it('resolves the disqualified set from the client is_lost statuses', async () => {
    const C = '55555555-5555-5555-5555-555555555555';
    __mock.setDefault('crm_settings', { data: CUSTOM });
    const set = await disqualifiedStatesFor(ORG, C);
    expect(set.has('not_interested')).toBe(true);
    expect(set.has('lost')).toBe(false);
  });
});
